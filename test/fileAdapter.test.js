import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileAdapter, FILE_ERROR } from '../src/adapters/file.js';
import { createService } from '../src/service.js';
import { defaultPolicy } from '../src/core/policy.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'demo-secret-0123456789';

async function makeExport(layout) {
  const dir = await mkdtemp(join(ROOT, '.tmp-export-'));
  for (const [slug, spec] of Object.entries(layout)) {
    const roomDir = join(dir, slug);
    await mkdir(roomDir, { recursive: true });
    await writeFile(join(roomDir, 'room.json'), JSON.stringify(spec.room));
    if (spec.text !== undefined) await writeFile(join(roomDir, 'messages.txt'), spec.text);
    if (spec.jsonl !== undefined) await writeFile(join(roomDir, 'messages.jsonl'), spec.jsonl);
  }
  return dir;
}

const STANDARD_LAYOUT = {
  'prod-review': {
    room: { name: '产品评审群', kind: 'group', id: 'prod-review' },
    text: [
      '[2026-11-10 09:12] 小王: 周五前把评审稿交上来',
      '[2026-11-10 09:15] 老李: 待办：确认服务器预算，截止周三',
      '[2026-11-10 09:20] 小张: @小王 数据口径按上周定的来',
    ].join('\n'),
  },
  'someone': {
    room: { name: '某人', kind: 'private', id: 'someone' },
    text: '[2026-11-10 09:13] 某人: 待办：私下约个时间 PRIV-FILE-9b7d3e01',
  },
};

test('文件适配器：解析目录、合成合法会话 id', async () => {
  const dir = await makeExport(STANDARD_LAYOUT);
  try {
    const rooms = await createFileAdapter({ exportRoot: dir }).listRooms();
    const byRaw = Object.fromEntries(rooms.map((room) => [room.rawId, room]));
    assert.ok(byRaw['prod-review@chatroom'], '群应被合成成 @chatroom 形态');
    assert.ok(byRaw.wxid_someone, '私聊应被合成成 wxid_ 形态');
    assert.equal(byRaw['prod-review@chatroom'].authoritativeKind, 'group');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件适配器：文本行解析出发送人与时间', async () => {
  const dir = await makeExport(STANDARD_LAYOUT);
  try {
    const adapter = createFileAdapter({ exportRoot: dir });
    const rooms = await adapter.listRooms();
    const group = rooms.find((room) => room.authoritativeKind === 'group');
    const messages = await adapter.fetchMessages({ room: group, fromSeq: 0 });
    assert.equal(messages.length, 3);
    assert.equal(messages[0].sender, '小王');
    assert.equal(messages[0].at, '2026-11-10 09:12');
    assert.equal(messages[1].seq, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件适配器：jsonl 也可读', async () => {
  const dir = await makeExport({
    chat: {
      room: { name: '群', kind: 'group', id: 'chat' },
      jsonl: [
        JSON.stringify({ at: '2026-11-10T09:00:00+08:00', sender: 'A', text: '待办：写周报' }),
        JSON.stringify({ at: '2026-11-10T09:05:00+08:00', sender: 'B', text: '收到' }),
      ].join('\n'),
    },
  });
  try {
    const adapter = createFileAdapter({ exportRoot: dir });
    const rooms = await adapter.listRooms();
    const messages = await adapter.fetchMessages({ room: rooms[0], fromSeq: 0 });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].sender, 'A');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('端到端：文件模式同样只读群、私聊被拒且哨兵零出现', async () => {
  const dir = await makeExport(STANDARD_LAYOUT);
  try {
    const service = createService({
      adapter: createFileAdapter({ exportRoot: dir }),
      secret: SECRET,
    });

    const rooms = await service.listRooms();
    assert.equal(rooms.allowed.length, 1, '默认策略下只有群可读');
    assert.ok(rooms.denied.some((item) => item.reason === 'PRIVATE_DISABLED'));

    const result = await service.runSummary({ trigger: 'manual' });
    assert.equal(result.status, 'COMPLETED');

    const everything = JSON.stringify(service.store.all());
    assert.ok(everything.includes('周五前把评审稿交上来'), '群的要点应出现');
    assert.equal(everything.includes('PRIV-FILE-9b7d3e01'), false, '私聊哨兵必须零出现');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件模式是全量快照：连跑两次都能产出（不被水位线吃掉）', async () => {
  const dir = await makeExport(STANDARD_LAYOUT);
  try {
    const service = createService({
      adapter: createFileAdapter({ exportRoot: dir }),
      secret: SECRET,
    });

    const first = await service.runSummary({ trigger: 'scheduled' });
    const second = await service.runSummary({ trigger: 'scheduled' });
    assert.equal(first.summarized.length, 1);
    assert.equal(second.summarized.length, 1, '快照模式必须重新处理，否则第二次会意外为空');
    assert.equal(service.store.all().length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('打开私聊开关后文件模式的私聊也可读', async () => {
  const dir = await makeExport(STANDARD_LAYOUT);
  try {
    const policy = defaultPolicy();
    policy.private.defaultEnabled = true;
    const service = createService({
      adapter: createFileAdapter({ exportRoot: dir }),
      secret: SECRET,
      policy,
    });
    const rooms = await service.listRooms();
    assert.equal(rooms.allowed.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺 room.json 的子目录被忽略，不报错', async () => {
  const dir = await makeExport({});
  try {
    await mkdir(join(dir, 'stray'), { recursive: true });
    await writeFile(join(dir, 'stray', 'messages.txt'), 'hi');
    const rooms = await createFileAdapter({ exportRoot: dir }).listRooms();
    assert.equal(rooms.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('非法 kind 被拒', async () => {
  const dir = await makeExport({ bad: { room: { name: 'x', kind: 'groupchat', id: 'bad' }, text: 'hi' } });
  try {
    await assert.rejects(() => createFileAdapter({ exportRoot: dir }).listRooms(), (err) => err.code === FILE_ERROR.ROOM_INVALID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('目录穿越的 id 被拒', async () => {
  const dir = await makeExport({ bad: { room: { name: 'x', kind: 'group', id: '../escape' }, text: 'hi' } });
  try {
    await assert.rejects(() => createFileAdapter({ exportRoot: dir }).listRooms(), (err) => err.code === FILE_ERROR.ROOM_INVALID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺消息文件被拒', async () => {
  const dir = await makeExport({ empty: { room: { name: 'x', kind: 'group', id: 'empty' } } });
  try {
    await assert.rejects(() => createFileAdapter({ exportRoot: dir }).listRooms(), (err) => err.code === FILE_ERROR.MESSAGES_MISSING);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('导出目录不存在时显式失败', async () => {
  await assert.rejects(
    () => createFileAdapter({ exportRoot: join(ROOT, 'no-such-export') }).listRooms(),
    (err) => err.code === FILE_ERROR.EXPORT_ROOT_MISSING,
  );
});
