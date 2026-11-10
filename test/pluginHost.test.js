/**
 * 宿主半契约测试：不需要重启 DSH，用假 ctx 捕获路由再打请求。
 *
 * 核心断言：**分派只依赖 method + 请求头**，不依赖 req.url 的呈现方式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, name, inject, originAllowed, operationOf } from '../lib/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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

function fakeReq(method, { payload, headers, url } = {}) {
  const req = { method, headers: headers ?? {}, url: url ?? '/' };
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
  const dir = await mkdtemp(join(ROOT, '.tmp-plugin-'));
  const exportsDir = join(dir, 'exports');
  await mkdir(join(exportsDir, 'g1'), { recursive: true });
  await writeFile(join(exportsDir, 'g1', 'room.json'), JSON.stringify({ name: '群一', kind: 'group', id: 'g1' }));
  await writeFile(join(exportsDir, 'g1', 'messages.txt'), '[2026-11-10 09:12] 小王: 周五前交评审稿\n');

  const prev = { data: process.env.WECHAT_DIGEST_DATA_DIR, exp: process.env.WECHAT_DIGEST_EXPORT_DIR };
  process.env.WECHAT_DIGEST_DATA_DIR = join(dir, 'data');
  process.env.WECHAT_DIGEST_EXPORT_DIR = exportsDir;
  await mkdir(process.env.WECHAT_DIGEST_DATA_DIR, { recursive: true });

  try {
    return await fn({ dir });
  } finally {
    if (prev.data === undefined) delete process.env.WECHAT_DIGEST_DATA_DIR;
    else process.env.WECHAT_DIGEST_DATA_DIR = prev.data;
    if (prev.exp === undefined) delete process.env.WECHAT_DIGEST_EXPORT_DIR;
    else process.env.WECHAT_DIGEST_EXPORT_DIR = prev.exp;
    await rm(dir, { recursive: true, force: true });
  }
}

const BASE_STATE = { headers: { host: '127.0.0.1:1402' } };

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
    fakeReq('POST', { headers: { host: 'h', 'x-wechat-digest-op': 'config' }, payload: { ...HEURISTIC_CONFIG, ...overrides } }),
    res,
  );
  assert.equal(res._out.status, 200, res._out.body);
}

test('POST + op=run 立即总结并返回渲染文本', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    await saveHeuristic(route);

    const res = fakeRes();
    await route.handler(fakeReq('POST', { headers: { host: 'h', 'x-wechat-digest-op': 'run' } }), res);

    assert.equal(res._out.status, 200);
    const body = JSON.parse(res._out.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'COMPLETED');
    assert.equal(body.summarized, 1);
    assert.ok(body.items[0].text.includes('周五前交评审稿'), '应返回渲染后的摘要文本');
    assert.equal(typeof body.items[0].roomHandle, 'string');
  });
});

test('op=run 也受总开关约束（关群后立即总结不产出）', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    await saveHeuristic(route, { groupsEnabled: false });

    const res = fakeRes();
    await route.handler(fakeReq('POST', { headers: { host: 'h', 'x-wechat-digest-op': 'run' } }), res);
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

test('卸载时释放路由', () => {
  const captured = captureRoute();
  assert.equal(captured.effects.length, 1);
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

test('同源校验：无 Origin 放行，跨源拒绝，同源放行', () => {
  assert.equal(originAllowed(fakeReq('GET', { headers: {} })), true);
  assert.equal(
    originAllowed(fakeReq('GET', { headers: { host: '127.0.0.1:1402', origin: 'https://evil.example' } })),
    false,
  );
  assert.equal(
    originAllowed(fakeReq('GET', { headers: { host: '127.0.0.1:1402', origin: 'http://127.0.0.1:1402' } })),
    true,
  );
});

test('GET + op 头 返回配置与群列表', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    const res = fakeRes();
    await route.handler(fakeReq('GET', { ...BASE_STATE, headers: { host: '127.0.0.1:1402', 'x-wechat-digest-op': 'state' } }), res);

    assert.equal(res._out.status, 200);
    const body = JSON.parse(res._out.body);
    assert.equal(typeof body.configPath, 'string');
    assert.equal(body.config.private.enabled, false);
    assert.deepEqual(body.rooms.map((room) => room.name), ['群一']);
  });
});

test('URL 里带 /state 也能拿到状态（不依赖框架怎么呈现 req.url）', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    for (const url of ['/wechat-digest/api/state', 'wechat-digest/api/state', '/state', '/']) {
      const res = fakeRes();
      await route.handler(fakeReq('GET', { headers: { host: 'h' }, url }), res);
      assert.equal(res._out.status, 200, url);
    }
  });
});

test('POST + op=config 保存后能读回', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    const payload = {
      version: 1,
      groups: { 'g1@chatroom': { enabled: false } },
      private: { enabled: false },
      summarizer: 'heuristic',
      schedule: { enabled: true, kind: 'weekly', weekdays: ['MO'], time: '08:30', timeZone: 'Asia/Shanghai' },
    };

    const saveRes = fakeRes();
    await route.handler(
      fakeReq('POST', { headers: { host: 'h', 'x-wechat-digest-op': 'config' }, payload }),
      saveRes,
    );
    assert.equal(saveRes._out.status, 200);
    assert.equal(JSON.parse(saveRes._out.body).ok, true);

    const stateRes = fakeRes();
    await route.handler(fakeReq('GET', { headers: { host: 'h', 'x-wechat-digest-op': 'state' } }), stateRes);
    const state = JSON.parse(stateRes._out.body);
    assert.equal(state.config.summarizer, 'heuristic');
    assert.equal(state.config.schedule.time, '08:30');
  });
});

test('非法配置 → 400，且不把配置写坏', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    const res = fakeRes();
    await route.handler(
      fakeReq('POST', { headers: { host: 'h', 'x-wechat-digest-op': 'config' }, payload: { version: 1, summarizer: 'gpt' } }),
      res,
    );
    assert.equal(res._out.status, 400);
    assert.match(JSON.parse(res._out.body).reason, /SUMMARIZER_INVALID/);

    const stateRes = fakeRes();
    await route.handler(fakeReq('GET', { headers: { host: 'h', 'x-wechat-digest-op': 'state' } }), stateRes);
    assert.equal(JSON.parse(stateRes._out.body).configError, null);
  });
});

test('method 不匹配 → 405', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    const getConfig = fakeRes();
    await route.handler(fakeReq('GET', { headers: { host: 'h', 'x-wechat-digest-op': 'config' } }), getConfig);
    assert.equal(getConfig._out.status, 405);
  });
});

test('跨源请求 → 403', async () => {
  await withDataDir(async () => {
    const { route } = captureRoute();
    const res = fakeRes();
    await route.handler(
      fakeReq('POST', {
        headers: { host: '127.0.0.1:1402', origin: 'https://evil.example', 'x-wechat-digest-op': 'reset' },
      }),
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
        headers: { host: 'h', 'x-wechat-digest-op': 'config' },
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
    await route.handler(fakeReq('POST', { headers: { host: 'h', 'x-wechat-digest-op': 'reset' } }), resetRes);
    assert.equal(resetRes._out.status, 200);

    const stateRes = fakeRes();
    await route.handler(fakeReq('GET', { headers: { host: 'h', 'x-wechat-digest-op': 'state' } }), stateRes);
    const state = JSON.parse(stateRes._out.body);
    assert.equal(state.config.private.enabled, false);
    assert.equal(state.config.schedule.time, '09:00');
  });
});
