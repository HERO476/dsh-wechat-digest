/**
 * dsh-wechat-digest 宿主半（Host half）。
 *
 * 提供设置面板需要的操作（读状态 / 存配置 / 恢复默认 / 立即总结）与定时触发。
 *
 * 四个设计决定，都有依据：
 *
 * 1) webServer 不写进 `inject`：宿主行挂载早于 webServer 发布，apply 时一次性
 *    `ctx.get('webServer')` 会拿到 undefined 并永久放弃。改用非阻塞的
 *    `ctx.inject(['webServer'], …)`。
 *
 * 2) **不根据 `req.url` 分派**：同机可用插件的源码里明确写着
 *    "how the harness presents `req.url` to it is not part of any contract"。
 *    所以分派只依赖两样契约内的东西：HTTP method 与请求头
 *    （`x-wechat-digest-op`）。URL 里的 /state /config /reset 只作为兜底线索。
 *
 * 3) 访问控制改成 **Host 白名单 + 写操作强制同源 Origin**：
 *    - 原来是「没有 Origin 就放行」，一条 `curl` 就能改配置（能把私聊读开关打开）；
 *    - 只比 Origin 与 Host 是否相等也挡不住 DNS rebinding（攻击页的 Origin 与 Host 都是 evil.example）；
 *    - 现在 Host 必须是回环地址（或显式写进 WECHAT_DIGEST_ALLOWED_HOSTS 的隧道域名），
 *      且 POST/PUT 必须带 Origin 且与 Host 相同。浏览器一定带 Origin，程序化调用不带 → 拒绝。
 *
 * 4) 定时总结在这里真正被消费：`config.schedule` 命中后调用与「立即总结」同一条 postRun。
 */

import { getState, postConfig, postReset, postRun, resolvePaths } from '../src/settings-api.js';
import { createScheduler } from './scheduler.mjs';

export const name = 'wechat-digest';

// 故意为空：webServer 交给非阻塞子 fiber 等待发布。
export const inject = [];

/** 单一挂载点；子路径不参与分派。 */
const MOUNT = '/wechat-digest';

const OP_HEADER = 'x-wechat-digest-op';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** 只允许本机回环地址；隧道域名要显式声明。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function headerOf(req, name) {
  const headers = req && typeof req === 'object' ? req.headers : null;
  if (!headers || typeof headers !== 'object') return undefined;
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** 从 Host 头取主机名（去端口，保留 IPv6 方括号形式）。 */
function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return null;
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? null : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/** 允许的主机名集合：回环 + WECHAT_DIGEST_ALLOWED_HOSTS 显式追加。 */
export function allowedHosts(env = process.env) {
  const extra = String(env?.WECHAT_DIGEST_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  return new Set([...LOOPBACK_HOSTNAMES, ...extra]);
}

export function hostAllowed(req, env = process.env) {
  const hostname = hostnameOf(headerOf(req, 'host') ?? '');
  if (!hostname) return false;
  return allowedHosts(env).has(hostname);
}

/**
 * 访问控制：
 *  - Host 必须在白名单里（挡 DNS rebinding / 隧道直连）；
 *  - 读请求（GET/HEAD）不要求 Origin；
 *  - 写请求必须有 Origin，且 Origin 的 host 与 Host 完全一致。
 */
export function originAllowed(req, env = process.env) {
  if (!hostAllowed(req, env)) return false;

  const method = String(req?.method ?? 'GET').toUpperCase();
  const requiresOrigin = method !== 'GET' && method !== 'HEAD';

  const origin = headerOf(req, 'origin');
  const hasOrigin = typeof origin === 'string' && origin.length > 0;
  if (!hasOrigin) return !requiresOrigin;

  const host = headerOf(req, 'host');
  if (typeof host !== 'string' || host.length === 0) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** 拒绝原因：区分「主机不允许」与「跨源」，便于排障与测试。 */
export function rejectionOf(req, env = process.env) {
  if (!hostAllowed(req, env)) return 'HOST_NOT_ALLOWED';
  return 'CROSS_ORIGIN_DENIED';
}

/** 操作分派：请求头优先，URL 兜底，最后按 method 推断。 */
export function operationOf(req) {
  const declared = headerOf(req, OP_HEADER);
  if (declared === 'state' || declared === 'config' || declared === 'reset' || declared === 'run') return declared;

  const url = typeof req?.url === 'string' ? req.url : '';
  if (url.includes('/reset')) return 'reset';
  if (url.includes('/run')) return 'run';
  if (url.includes('/config')) return 'config';
  if (url.includes('/state')) return 'state';

  return req?.method === 'GET' || req?.method === 'HEAD' ? 'state' : 'config';
}

async function readJsonBody(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new Error('BODY_TOO_LARGE');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? {} : JSON.parse(text);
}

export function createHandler(paths = resolvePaths(), env = process.env) {
  return async function handler(req, res) {
    if (!originAllowed(req, env)) {
      sendJson(res, 403, { ok: false, reason: rejectionOf(req, env) });
      return;
    }

    const op = operationOf(req);

    try {
      if (op === 'state') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, reason: 'METHOD_NOT_ALLOWED' });
          return;
        }
        sendJson(res, 200, await getState(paths, env));
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, reason: 'METHOD_NOT_ALLOWED' });
        return;
      }

      if (op === 'reset') {
        sendJson(res, 200, postReset(paths));
        return;
      }

      if (op === 'run') {
        sendJson(res, 200, await postRun(paths, { trigger: 'manual', env }));
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { ok: false, reason: err?.code ?? 'BAD_JSON' });
        return;
      }
      try {
        sendJson(res, 200, await postConfig(payload, paths, env));
      } catch (err) {
        sendJson(res, 400, { ok: false, reason: err?.message ?? 'CONFIG_INVALID' });
      }
    } catch (err) {
      sendJson(res, 500, { ok: false, reason: String(err?.code ?? err?.message ?? err) });
    }
  };
}

export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.webServer;
    if (!webServer || typeof webServer.register !== 'function') {
      console.error('[wechat-digest] webServer 没有 register()，设置面板将无法读写配置');
      return;
    }

    const paths = resolvePaths();

    let dispose = null;
    try {
      dispose = webServer.register({ kind: 'prefix', path: MOUNT, handler: createHandler(paths) });
      console.error(
        `[wechat-digest] 设置路由已注册于 ${MOUNT}（分派依据：method + ${OP_HEADER}；访问控制：Host 白名单 + 写操作同源）`,
      );
    } catch (err) {
      console.error('[wechat-digest] 路由注册失败：', err);
      return;
    }

    // 定时总结：真正消费 config.schedule（以前配置了但没有任何消费者）。
    // WECHAT_DIGEST_SCHEDULER=off 可关掉（测试用）。
    let stopScheduler = () => {};
    const schedulerEnabled = String(process.env.WECHAT_DIGEST_SCHEDULER ?? 'on').toLowerCase() !== 'off';
    if (schedulerEnabled) {
      try {
        const scheduler = createScheduler({
          paths,
          log: (message) => console.error(`[wechat-digest] ${message}`),
        });
        stopScheduler = scheduler.start();
      } catch (err) {
        console.error('[wechat-digest] 定时器启动失败：', err);
      }
    }

    scope.effect(() => () => {
      try {
        stopScheduler();
      } catch {
        /* ignore */
      }
      if (typeof dispose === 'function') {
        try {
          dispose();
        } catch (err) {
          console.error('[wechat-digest] 路由释放失败：', err);
        }
      }
    });
  });
}
