/**
 * 独立设置页的服务端契约测试（in-process，不起外部进程）。
 * 与 DSH 面板共用 settings-api，这里验证的是「页面真的能读到并写回配置」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSettingsServer } from '../scripts/settings-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function withServer(fn) {
  const dir = await mkdtemp(join(ROOT, '.tmp-page-'));
  const exportDir = join(dir, 'exports');
  const dataDir = join(dir, 'data');
  await mkdir(join(exportDir, 'g1'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(exportDir, 'g1', 'room.json'), JSON.stringify({ name: '群一', kind: 'group', id: 'g1' }));
  await writeFile(join(exportDir, 'g1', 'messages.txt'), '[2026-11-10 09:12] 小王: 周五前交评审稿\n');

  const server = createSettingsServer({ dataDir, exportDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    return await fn({ base, dataDir, exportDir });
  } finally {
    // 先断掉 keep-alive 连接再删目录：否则残留 socket 仍可能在读文件，
    // 与 rm 竞争，表现为偶发的 ENOENT / 断言失败（曾观察到一次）。
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('页面 HTML 可访问', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('微信摘要 · 设置'));
  });
});

test('页面包含总开关、名字框、模型选择与立即总结按钮', async () => {
  await withServer(async ({ base }) => {
    const html = await (await fetch(`${base}/`)).text();
    const markers = ['读取群聊（总开关）', '允许读取私聊（总开关', '自定义名字', '立即总结', '提供方'];
    for (const marker of markers) {
      assert.ok(html.includes(marker), `页面缺少: ${marker}`);
    }
  });
});

test('GET /api/state 返回配置、群列表与星期', async () => {
  await withServer(async ({ base }) => {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.configError, null);
    assert.equal(state.roomsError, null);
    assert.equal(state.config.private.enabled, false);
    assert.equal(state.config.schedule.time, '09:00');
    assert.deepEqual(state.rooms.map((room) => room.name), ['群一']);
    assert.equal(state.rooms[0].key, 'g1@chatroom');
    assert.equal(state.weekdays.length, 7);
  });
});

test('POST /api/config 写回并立即可读', async () => {
  await withServer(async ({ base }) => {
    const payload = {
      version: 1,
      groups: { 'g1@chatroom': { enabled: false } },
      private: { enabled: true },
      summarizer: 'heuristic',
      schedule: { enabled: true, kind: 'weekly', weekdays: ['MO', 'WE'], time: '08:30', timeZone: 'Asia/Shanghai' },
    };
    const saved = await (await fetch(`${base}/api/config`, { method: 'POST', body: JSON.stringify(payload) })).json();
    assert.equal(saved.ok, true);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.config.summarizer, 'heuristic');
    assert.equal(state.config.private.enabled, true);
    assert.equal(state.config.schedule.time, '08:30');
    assert.deepEqual(state.config.schedule.weekdays, ['MO', 'WE']);
    assert.equal(state.config.groups['g1@chatroom'].enabled, false);
  });
});

test('非法配置被拒，且不破坏已有配置', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/config`, { method: 'POST', body: JSON.stringify({ version: 1, summarizer: 'x' }) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.configError, null, '非法输入不应把配置文件写坏');
  });
});

test('坏 JSON 被拒', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/config`, { method: 'POST', body: '{不是 JSON' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, 'BAD_JSON');
  });
});

test('POST /api/reset 恢复默认', async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/api/config`, {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        groups: {},
        private: { enabled: true },
        summarizer: 'heuristic',
        schedule: { enabled: false, kind: 'weekly', weekdays: ['MO'], time: '07:00', timeZone: 'Asia/Shanghai' },
      }),
    });

    const reset = await (await fetch(`${base}/api/reset`, { method: 'POST' })).json();
    assert.equal(reset.ok, true);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.config.private.enabled, false);
    assert.equal(state.config.schedule.time, '09:00');
  });
});

test('未知路径 404；导出目录不可读时给出 roomsError', async () => {
  await withServer(async ({ base, exportDir }) => {
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);

    await rm(exportDir, { recursive: true, force: true });
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(state.roomsError, '导出目录没了应该报告 roomsError 而不是崩');
    assert.deepEqual(state.rooms, []);
  });
});

test('POST /api/run 立即总结（本地关键词，不联网）', async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/api/config`, {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        groupsEnabled: true,
        groups: {},
        private: { enabled: false, chats: {} },
        summarizer: 'heuristic',
        llm: { provider: 'deepseek-official', model: 'deepseek-flash' },
        schedule: { enabled: true, kind: 'weekly', weekdays: ['MO'], time: '09:00', timeZone: 'Asia/Shanghai' },
      }),
    });

    const res = await fetch(`${base}/api/run`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.summarized, 1);
    assert.ok(body.items[0].text.includes('周五前交评审稿'));
  });
});

test('POST /api/run 群聊总开关关掉时不产出', async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/api/config`, {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        groupsEnabled: false,
        groups: {},
        private: { enabled: false, chats: {} },
        summarizer: 'heuristic',
        llm: { provider: 'deepseek-official', model: 'deepseek-flash' },
        schedule: { enabled: true, kind: 'weekly', weekdays: ['MO'], time: '09:00', timeZone: 'Asia/Shanghai' },
      }),
    });

    const body = await (await fetch(`${base}/api/run`, { method: 'POST' })).json();
    assert.equal(body.summarized, 0);
  });
});

test('自定义名字：列表与摘要结果都用自定义名', async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/api/config`, {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        groupsEnabled: true,
        groups: { 'g1@chatroom': { enabled: true, name: '产品评审群' } },
        private: { enabled: false, chats: {} },
        summarizer: 'heuristic',
        llm: { provider: 'deepseek-official', model: 'deepseek-flash' },
        schedule: { enabled: true, kind: 'weekly', weekdays: ['MO'], time: '09:00', timeZone: 'Asia/Shanghai' },
      }),
    });

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.groups[0].name, '产品评审群', '列表应显示自定义名');

    const run = await (await fetch(`${base}/api/run`, { method: 'POST' })).json();
    assert.equal(run.items.length, 1);
    assert.equal(run.items[0].name, '产品评审群', '摘要结果也应带自定义名');
  });
});

test('清空自定义名字后回落到导出目录里的名字', async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/api/config`, {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        groupsEnabled: true,
        groups: { 'g1@chatroom': { enabled: true, name: '' } },
        private: { enabled: false, chats: {} },
        summarizer: 'heuristic',
        llm: { provider: 'deepseek-official', model: 'deepseek-flash' },
        schedule: { enabled: true, kind: 'weekly', weekdays: ['MO'], time: '09:00', timeZone: 'Asia/Shanghai' },
      }),
    });

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.groups[0].name, '群一');
  });
});
