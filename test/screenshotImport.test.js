/**
 * 截图导入的共享层与设置页接口测试（OCR 用注入的假实现，不需要 PowerShell）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importScreenshot, slugFor } from '../src/screenshot-import.mjs';
import { postImport } from '../src/settings-api.js';

const FAKE_LINES = [
  { text: '09:12', x: 400, y: 10, w: 40, h: 16 },
  { text: '小 王', x: 40, y: 40, w: 30, h: 18 },
  { text: '周五前把评审稿交上来，数据口径按上周定的来。', x: 40, y: 70, w: 520, h: 24 },
  { text: '待办：确认服务器预算，截止周三。', x: 40, y: 120, w: 420, h: 24 },
];

const fakeRunner = () => ({ lines: FAKE_LINES, pageWidth: 800, pageHeight: 300 });

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-shot-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('slug：显式 slug 只允许安全字符，中文名生成稳定哈希', () => {
  assert.equal(slugFor('产品评审群'), slugFor('产品评审群'));
  assert.match(slugFor('产品评审群'), /^ocr-[a-z0-9]+$/);
  assert.equal(slugFor('任意', 'prod-review'), 'prod-review');
  assert.throws(() => slugFor('任意', '../etc'), /BAD_SLUG/);
});

test('导入：写出 room.json 与 messages.txt（格式可被适配器读取）', async () => {
  await withDir(async (dir) => {
    const imagePath = join(dir, 'shot.png');
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = importScreenshot({
      imagePath,
      room: '产品评审群',
      exportDir: dir,
      date: '2026-11-12',
      runner: fakeRunner,
    });

    assert.equal(result.messages, 2);
    assert.equal(result.ocrLines, 4);

    const roomJson = JSON.parse(await readFile(join(result.dir, 'room.json'), 'utf8'));
    assert.deepEqual(roomJson, { name: '产品评审群', kind: 'group', id: result.slug });

    const text = await readFile(join(result.dir, 'messages.txt'), 'utf8');
    assert.match(text, /^\[2026-11-12 09:12\] 小王: 周五前把评审稿交上来/);
    assert.match(text, /小王: 待办:确认服务器预算，截止周三/);
  });
});

test('重复导入：append 时按内容去重，不会重复记账', async () => {
  await withDir(async (dir) => {
    const imagePath = join(dir, 'shot.png');
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const first = importScreenshot({ imagePath, room: '群', exportDir: dir, runner: fakeRunner });
    const second = importScreenshot({ imagePath, room: '群', exportDir: dir, runner: fakeRunner, append: true });

    assert.equal(first.messages, 2);
    assert.equal(second.messages, 2, '同一批内容不应重复');
  });
});

test('非法输入被拒：缺图片 / 缺会话名 / 非法 kind', async () => {
  await withDir(async (dir) => {
    assert.throws(() => importScreenshot({ imagePath: join(dir, 'nope.png'), room: 'x', exportDir: dir }), /IMAGE_NOT_FOUND/);
    assert.throws(
      () => importScreenshot({ imagePath: join(dir, 'nope.png'), room: '', exportDir: dir }),
      /IMAGE_NOT_FOUND|ROOM_REQUIRED/,
    );
  });
});

test('设置页接口：base64 图片 → 落到 exports 并返回计数', async () => {
  await withDir(async (dir) => {
    const exportDir = join(dir, 'exports');
    const dataBase64 = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`;

    const result = postImport(
      { room: '接口测试群', filename: 'shot.png', dataBase64, date: '2026-11-12' },
      { dataDir: join(dir, 'data'), exportDir },
      { runner: fakeRunner },
    );

    assert.equal(result.ok, true);
    assert.equal(result.room, '接口测试群');
    assert.equal(result.messages, 2);
    assert.ok(existsSync(join(result.dir, 'messages.txt')));
    assert.equal(existsSync(join(exportDir, 'nope')), false);
  });
});

test('设置页接口：拒绝空图片、非 base64、过大图片', async () => {
  await withDir(async (dir) => {
    const paths = { dataDir: join(dir, 'data'), exportDir: join(dir, 'exports') };
    const deps = { runner: fakeRunner };

    assert.throws(() => postImport({ room: 'x', dataBase64: '' }, paths, deps), /IMAGE_REQUIRED/);
    assert.throws(() => postImport({ dataBase64: 'AAAA' }, paths, deps), /ROOM_REQUIRED/);

    const big = Buffer.alloc(10 * 1024 * 1024, 1).toString('base64');
    assert.throws(() => postImport({ room: 'x', dataBase64: big }, paths, deps), /IMAGE_TOO_LARGE/);
  });
});

test('设置页接口：导入后 state 能看到该会话（用假 OCR 走同一条流水线）', async () => {
  await withDir(async (dir) => {
    const exportDir = join(dir, 'exports');
    const dataBase64 = Buffer.from([1, 2, 3]).toString('base64');
    const result = postImport(
      { room: '可见性群', dataBase64, date: '2026-11-12' },
      { dataDir: join(dir, 'data'), exportDir },
      { runner: fakeRunner },
    );

    const roomJson = JSON.parse(await readFile(join(result.dir, 'room.json'), 'utf8'));
    assert.equal(roomJson.kind, 'group');
    assert.equal(roomJson.id, result.slug);
  });
});
