/**
 * 宿主半契约测试：不需要重启 DSH，用假 ctx 捕获路由再打请求。
 *
 * 核心断言：
 *  1) 分派只依赖 method + 请求头，不依赖 req.url 的呈现方式；
 *  2) 访问控制是 Host 白名单 + 写操作强制同源 Origin。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, name, inject, originAllowed, hostAllowed, operationOf, rejectionOf } from '../lib/index.js';

// 这些用例只验证路由契约，不要顺带起定时器。
process.env.WECHAT_DIGEST_SCHEDULER = 'off';

const LOOPBACK = '127.0.0.1:1402';
const SAME_ORIGIN = `http://${LOOPBACK}`;

function fakeRes() {
  const out = { status: null, headers: null, body: null };
  return {
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(body) {
      out.body = body;
    },
    _out: out,
  };
}

/** 默认给回环 Host；写操作再补同源 Origin（真实浏览器一定带 Origin）。 */
function fakeReq(method, { payload, headers, url } = {}) {
  const defaults = { host: LOOPBACK };
  if (method !== 'GET' && method !== 'HEAD') defaults.origin = SAME_ORIGIN;

  const req = { method, headers: { ...defaults, ...(headers ?? {}) }, url: url ?? '/' };
  if (payload !== undefined) {
    req[Symbol.asyncIterator] = async function* iterate() {
      yield Buffer.from(JSON.stringify(payload), 'utf8');
    };
  }
  return req;
}

function captureRoute() {
  const captured = { route: null, disposed: 0, effects: [] };
  const scope = {
    webServer: {
      register(options) {
        captured.route = options;
        return () => {
          captured.disposed += 1;
        };
      },
    },
    effect(fn) {
      captured.effects.push(fn);
    },
  };
  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ['webServer'], '应该以非阻塞方式等待 webServer');
      callback(scope);
    },
    effect(fn) {
      captured.effects.push(fn);
    },
  };
  apply(ctx);
  assert.ok(captured.route, 'apply 之后必须注册了路由');
  return captured;
}

async function withDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-digest-plugin-'));
  const exportsDir = join(dir, 'exports');
  await mkdir(join(exportsDir, 'g1'), { recursive: true });
  await writeFile(join(exportsDir, 'g1', 'room.json'), JSON.stringify({ name: '群一', kind: 'group', id: 'g1' }));
  await writeFile(join(exportsDir, 'g1', 'messages.txt'), '[2026-11-10 09:12] 小王: 周五前交评审稿\n');

  const prev = { data: process.env.WECHAT_DIGEST_DATA_DIR, exp: process.env.WECHAT_DIGEST_EXPORT_DIR };
  process.env.WECHAT_DIGEST_DATA_DIR = join(dir, 'data');
  process.env.WECHAT_DIGEST_EXPORT_DIR = exportsDir;
  await mkdir(process.env.WECHAT_DIGEST_DATA_DIR, { recursive: true });

  try {
    return await fn({ dir, exportsDir });
  } finally {
    if (prev.data === undefined) delete process.env.WECHAT_DIGEST_DATA_DIR;
    else process.env.WECHAT_DIGEST_DATA_DIR = prev.data;
    if (prev.exp === undefined) delete process.env.WECHAT_DIGEST_EXPORT_DIR;
    else process.env.WECHAT_DIGEST_EXPORT_DIR = prev.exp;
    await rm(dir, { recursive: true, force: true });
  }
}

const HEURISTIC_CONFIG = {
  version: 1,
  groupsEnabled: true,
  groups: {},
  private: { enabled: false, chats: {} },
  summarizer: 'heuristic',
  llm: { provider: 'deepseek-official', model: 'deepseek-flash' },
  schedule: { enabled: true, kind: 'weekly', weekdays: ['MO'], time: '09:00', timeZone: 'Asia/Shanghai' },
};

async function saveHeuristic(route, overrides = {}) {
  const res = fakeRes();
  await route.handler(
    fakeReq('POST', { headers: { 'x-wechat-digest-op': 'config' }, payload: { ...HEURISTIC_CONFIG, ...overrides } }),
    res,
  );
  assert.equal(res._out.status, 200, res._out.body);
  return JSON.parse(res._out.body);
}

test('POST + op=run 立即总结并返回渲染文本', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    await saveHeuristic(route);

    const res = fakeRes();
    await route.handler(fakeReq('POST', { headers: { 'x-wechat-digest-op': 'run' } }), res);

    assert.equal(res._out.status, 200);
    const body = JSON.parse(res._out.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'COMPLETED');
    assert.equal(body.summarized, 1);
    assert.ok(body.items[0].text.includes('周五前交评审稿'), '应返回渲染后的摘要文本');
    assert.equal(typeof body.items[0].roomHandle, 'string');
    assert.match(body.items[0].roomHandle, /^[0-9a-f]{16}$/);
  });
});

test('op=run 也受总开关约束（关群后立即总结不产出）', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    await saveHeuristic(route, { groupsEnabled: false });

    const res = fakeRes();
    await route.handler(fakeReq('POST', { headers: { 'x-wechat-digest-op': 'run' } }), res);
    const body = JSON.parse(res._out.body);
    assert.equal(body.status, 'COMPLETED');
    assert.equal(body.summarized, 0, '群聊总开关关掉时不应摘要任何群');
  });
});

test('插件元信息正确', () => {
  assert.equal(name, 'wechat-digest');
  assert.deepEqual(inject, [], 'webServer 不能写进 inject（一次性读会拿到 undefined）');
});

test('只注册一个挂载点，不靠子路径', () => {
  const captured = captureRoute();
  assert.equal(captured.route.kind, 'prefix');
  assert.equal(captured.route.path, '/wechat-digest');
  assert.equal(typeof captured.route.handler, 'function');
});

test('卸载时释放路由（并停掉定时器）', () => {
  const captured = captureRoute();
  assert.equal(captured.effects.length, 1);
  // 定时器已启动 → dispose 之后不应再有 interval 挂在事件循环上
  captured.effects[0]()();
  assert.equal(captured.disposed, 1);
});

test('分派优先级：请求头 > URL 线索 > method', () => {
  assert.equal(operationOf(fakeReq('POST', { headers: { 'x-wechat-digest-op': 'reset' } })), 'reset');
  assert.equal(operationOf(fakeReq('GET', { url: '/wechat-digest/api/state' })), 'state');
  assert.equal(operationOf(fakeReq('POST', { url: '/wechat-digest/api/reset' })), 'reset');
  assert.equal(operationOf(fakeReq('GET', { url: '/' })), 'state', '无线索的 GET 按状态读取');
  assert.equal(operationOf(fakeReq('POST', { url: '/' })), 'config', '无线索的 POST 按保存配置');
});

test('Host 白名单：回环允许，外部域名拒绝', () => {
  assert.equal(hostAllowed(fakeReq('GET', { headers: { host: '127.0.0.1:4845' } })), true);
  assert.equal(hostAllowed(fakeReq('GET', { headers: { host: 'localhost:4845' } })), true);
  assert.equal(hostAllowed(fakeReq('GET', { headers: { host: '[::1]:4845' } })), true);
  assert.equal(hostAllowed(fakeReq('GET', { headers: { host: '' } })), false);
  assert.equal(hostAllowed(fakeReq('GET', { headers: { host: 'evil.example' } })), false);
});

test('Host 白名单可用 WECHAT_DIGEST_ALLOWED_HOSTS 显式放行隧道域名', () => {
  const env = { WECHAT_DIGEST_ALLOWED_HOSTS: 'abc-def.trycloudflare.com' };
  assert.equal(hostAllowed(fakeReq('GET', { headers: { host: 'abc-def.trycloudflare.com' } }), env), true);
  assert.equal(hostAllowed(fakeReq('GET', { headers: { host: 'other.trycloudflare.com' } }), env), false);
});

test('同源校验：读不要 Origin；写必须同源 Origin；rebinding 被挡', () => {
  // 读：有回环 Host 就够
  assert.equal(originAllowed(fakeReq('GET', { headers: {} })), true);
  // 写：完全没有 Origin 一律拒（curl 改配置的路径被关掉）
  assert.equal(originAllowed(fakeReq('POST', { headers: { origin: '' } })), false);
  // 写：跨源拒绝
  assert.equal(
    originAllowed(fakeReq('POST', { headers: { host: LOOPBACK, origin: 'https://evil.example' } })),
    false,
  );
  // 写：同源放行
  assert.equal(originAllowed(fakeReq('POST', { headers: { host: LOOPBACK, origin: SAME_ORIGIN } })), true);
  // DNS rebinding：Origin 与 Host 都是攻击域名 → 以前会放行，现在 Host 不在白名单 → 拒
  assert.equal(
    originAllowed(fakeReq('POST', { headers: { host: 'evil.example', origin: 'https://evil.example' } })),
    false,
  );
  assert.equal(rejectionOf(fakeReq('POST', { headers: { host: 'evil.example', origin: 'https://evil.example' } })), 'HOST_NOT_ALLOWED');
});

test('GET + op 头 返回配置与群列表（不含原始 id 与绝对路径）', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    const res = fakeRes();
    await route.handler(fakeReq('GET', { headers: { 'x-wechat-digest-op': 'state' } }), res);

    assert.equal(res._out.status, 200);
    const body = JSON.parse(res._out.body);
    // 不再外泄宿主绝对路径，只给目录名
    assert.equal(body.configPath, undefined);
    assert.equal(typeof body.dataDirName, 'string');
    assert.equal(body.config.private.enabled, false);
    assert.deepEqual(body.rooms.map((room) => room.name), ['群一']);
    // 群列表只给句柄，不给原始会话 id
    assert.match(body.rooms[0].roomHandle, /^[0-9a-f]{16}$/);
    assert.equal(body.rooms[0].key, undefined);
    assert.ok(!JSON.stringify(body).includes('g1@chatroom'), '响应体里不应出现原始会话 id');
  });
});

test('URL 里带 /state 也能拿到状态（不依赖框架怎么呈现 req.url）', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    for (const url of ['/wechat-digest/api/state', 'wechat-digest/api/state', '/state', '/']) {
      const res = fakeRes();
      await route.handler(fakeReq('GET', { url }), res);
      assert.equal(res._out.status, 200, url);
    }
  });
});

test('POST + op=config 保存后能读回（句柄可回翻成会话）', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();

    const stateRes = fakeRes();
    await route.handler(fakeReq('GET', { headers: { 'x-wechat-digest-op': 'state' } }), stateRes);
    const handle = JSON.parse(stateRes._out.body).rooms[0].roomHandle;

    const payload = {
      version: 1,
      groupsEnabled: true,
      groups: { [handle]: { enabled: false, name: '产品评审群' } },
      private: { enabled: false, chats: {} },
      summarizer: 'heuristic',
      schedule: { enabled: true, kind: 'weekly', weekdays: ['MO'], time: '08:30', timeZone: 'Asia/Shanghai' },
    };

    const saveRes = fakeRes();
    await route.handler(fakeReq('POST', { headers: { 'x-wechat-digest-op': 'config' }, payload }), saveRes);
    assert.equal(saveRes._out.status, 200, saveRes._out.body);
    const saved = JSON.parse(saveRes._out.body);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.unresolvedHandles, []);

    const after = fakeRes();
    await route.handler(fakeReq('GET', { headers: { 'x-wechat-digest-op': 'state' } }), after);
    const state = JSON.parse(after._out.body);
    assert.equal(state.config.summarizer, 'heuristic');
    assert.equal(state.config.schedule.time, '08:30');
    // 勾选状态按句柄回给前端
    assert.equal(state.selected.groups[handle].enabled, false);
    assert.equal(state.selected.groups[handle].name, '产品评审群');
    assert.deepEqual(state.config.groups, {}, '配置本体不回传原始 id');
  });
});

test('保存时无法解析的句柄被报告而不是静默丢弃', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    const ghost = 'ffffffffffffffff';
    const saved = await saveHeuristic(route, { groups: { [ghost]: { enabled: false } } });
    assert.deepEqual(saved.unresolvedHandles, [ghost]);
  });
});

test('非法配置 → 400，且不把配置写坏', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    const res = fakeRes();
    await route.handler(
      fakeReq('POST', { headers: { 'x-wechat-digest-op': 'config' }, payload: { version: 1, summarizer: 'gpt' } }),
      res,
    );
    assert.equal(res._out.status, 400);
    assert.match(JSON.parse(res._out.body).reason, /SUMMARIZER_INVALID/);

    const stateRes = fakeRes();
    await route.handler(fakeReq('GET', { headers: { 'x-wechat-digest-op': 'state' } }), stateRes);
    assert.equal(JSON.parse(stateRes._out.body).configError, null);
  });
});

test('method 不匹配 → 405', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    const getConfig = fakeRes();
    await route.handler(fakeReq('GET', { headers: { 'x-wechat-digest-op': 'config' } }), getConfig);
    assert.equal(getConfig._out.status, 405);
  });
});

test('跨源请求 → 403', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    const res = fakeRes();
    await route.handler(
      fakeReq('POST', {
        headers: { host: LOOPBACK, origin: 'https://evil.example', 'x-wechat-digest-op': 'reset' },
      }),
      res,
    );
    assert.equal(res._out.status, 403);
    assert.equal(JSON.parse(res._out.body).reason, 'CROSS_ORIGIN_DENIED');
  });
});

test('POST 缺 Origin → 403（挡住 curl 直接改配置）', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    const res = fakeRes();
    await route.handler(
      fakeReq('POST', { headers: { origin: '', 'x-wechat-digest-op': 'reset' } }),
      res,
    );
    assert.equal(res._out.status, 403);
    assert.equal(JSON.parse(res._out.body).reason, 'CROSS_ORIGIN_DENIED');
  });
});

test('POST + op=reset 恢复默认', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    await route.handler(
      fakeReq('POST', {
        headers: { 'x-wechat-digest-op': 'config' },
        payload: {
          version: 1,
          groups: {},
          private: { enabled: true },
          summarizer: 'heuristic',
          schedule: { enabled: false, kind: 'weekly', weekdays: ['MO'], time: '07:00', timeZone: 'Asia/Shanghai' },
        },
      }),
      fakeRes(),
    );

    const resetRes = fakeRes();
    await route.handler(fakeReq('POST', { headers: { 'x-wechat-digest-op': 'reset' } }), resetRes);
    assert.equal(resetRes._out.status, 200);

    const stateRes = fakeRes();
    await route.handler(fakeReq('GET', { headers: { 'x-wechat-digest-op': 'state' } }), stateRes);
    const state = JSON.parse(stateRes._out.body);
    assert.equal(state.config.private.enabled, false);
    assert.equal(state.config.schedule.time, '09:00');
  });
});
