/**
 * dsh-wechat-digest 宿主半（Host half）。
 *
 * 提供设置面板需要的三个操作：读状态、存配置、恢复默认。
 *
 * 三个设计决定，都有依据：
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
 * 3) 同源校验：设置接口能改「是否允许读私聊」，而本机开着公网隧道。
 *    带 Origin 且与 Host 不一致的请求一律 403（浏览器跨站发起的写操作）。
 */

import { getState, postConfig, postReset, postRun, resolvePaths } from '../src/settings-api.js';

export const name = 'wechat-digest';

// 故意为空：webServer 交给非阻塞子 fiber 等待发布。
export const inject = [];

/** 单一挂载点；子路径不参与分派。 */
const MOUNT = '/wechat-digest';

const OP_HEADER = 'x-wechat-digest-op';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

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

/** 同源校验：无 Origin（导航/服务端调用）放行；有 Origin 必须与 Host 一致。 */
export function originAllowed(req) {
  const origin = headerOf(req, 'origin');
  if (typeof origin !== 'string' || origin.length === 0) return true;
  const host = headerOf(req, 'host');
  if (typeof host !== 'string' || host.length === 0) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
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

export function createHandler(paths = resolvePaths()) {
  return async function handler(req, res) {
    if (!originAllowed(req)) {
      sendJson(res, 403, { ok: false, reason: 'CROSS_ORIGIN_DENIED' });
      return;
    }

    const op = operationOf(req);

    try {
      if (op === 'state') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, reason: 'METHOD_NOT_ALLOWED' });
          return;
        }
        sendJson(res, 200, await getState(paths));
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
        sendJson(res, 200, await postRun(paths));
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
        sendJson(res, 200, postConfig(payload, paths));
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

    let dispose = null;
    try {
      dispose = webServer.register({ kind: 'prefix', path: MOUNT, handler: createHandler() });
      console.error(`[wechat-digest] 设置路由已注册于 ${MOUNT}（分派依据：method + ${OP_HEADER}）`);
    } catch (err) {
      console.error('[wechat-digest] 路由注册失败：', err);
      return;
    }

    scope.effect(() => () => {
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
