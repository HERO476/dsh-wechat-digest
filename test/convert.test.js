import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { convertDatabase, detectSchema, formatTime } from '../scripts/convert-decrypted-db.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const GROUP_A = '11111111@chatroom';
const GROUP_B = '22222222@chatroom';
const PRIVATE = 'wxid_secret_private';

async function makeDb() {
  const dir = await mkdtemp(join(ROOT, '.tmp-convert-'));
  const path = join(dir, 'decrypted.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE Msg_abc (talker TEXT, create_time INTEGER, content TEXT, is_sender INTEGER)');
  db.exec('CREATE TABLE Name2Id (user_name TEXT)');
  const insert = db.prepare('INSERT INTO Msg_abc (talker, create_time, content, is_sender) VALUES (?, ?, ?, ?)');

  insert.run(GROUP_A, 1762737120, '周五前要交评审稿', 0);
  insert.run(GROUP_A, 1762737300, '我收到', 1);
  insert.run(GROUP_B, 1762737400, '下午三点开会', 0);
  insert.run(PRIVATE, 1762737500, '这是私聊原文-SECRET-PRIVATE', 0);
  insert.run(GROUP_B, 1762737600, null, 0);

  db.close();
  return { dir, path };
}

test('只导出群聊：私聊连文件都不生成', async () => {
  const { dir, path } = await makeDb();
  const out = join(dir, 'out');
  try {
    const report = convertDatabase(path, { outRoot: out });
    assert.equal(report.rooms.length, 2, '应只导出两个群');
    assert.deepEqual(report.rooms.map((room) => room.slug).sort(), ['11111111', '22222222']);

    const dirs = await readdir(out);
    assert.equal(dirs.length, 2);
    assert.equal(dirs.includes('wxid_secret_private'), false, '私聊目录不得存在');

    // 整个输出树里不得出现私聊原文或私聊 id
    for (const name of dirs) {
      const text = await readFile(join(out, name, 'messages.txt'), 'utf8');
      assert.equal(text.includes('SECRET-PRIVATE'), false, `${name} 泄露了私聊原文`);
      assert.equal(text.includes(PRIVATE), false, `${name} 泄露了私聊 id`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('生成的 room.json 是 group 且 id 合法', async () => {
  const { dir, path } = await makeDb();
  const out = join(dir, 'out');
  try {
    convertDatabase(path, { outRoot: out });
    const meta = JSON.parse(await readFile(join(out, '11111111', 'room.json'), 'utf8'));
    assert.equal(meta.kind, 'group');
    assert.match(meta.id, /^[a-z0-9_-]{1,64}$/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dry-run 不写任何文件，但报告映射', async () => {
  const { dir, path } = await makeDb();
  const out = join(dir, 'out-dry');
  try {
    const report = convertDatabase(path, { outRoot: out, dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.schema.table, 'Msg_abc');
    assert.equal(report.schema.talkerCol, 'talker');
    assert.equal(report.schema.contentCol, 'content');
    assert.equal(report.schema.timeCol, 'create_time');
    assert.equal(report.rooms.length, 2);

    let exists = true;
    try {
      await readdir(out);
    } catch {
      exists = false;
    }
    assert.equal(exists, false, 'dry-run 不得创建输出目录');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('消息行按时间排序，发送者能区分', async () => {
  const { dir, path } = await makeDb();
  const out = join(dir, 'out');
  try {
    convertDatabase(path, { outRoot: out });
    const text = await readFile(join(out, '11111111', 'messages.txt'), 'utf8');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('周五前要交评审稿'));
    assert.ok(lines[0].includes('群成员'));
    assert.ok(lines[1].includes('我: 我收到'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('空内容行被跳过并计数', async () => {
  const { dir, path } = await makeDb();
  const out = join(dir, 'out');
  try {
    const report = convertDatabase(path, { outRoot: out });
    assert.equal(report.skipped.empty, 1);
    const text = await readFile(join(out, '22222222', 'messages.txt'), 'utf8');
    assert.equal(text.trim().split('\n').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('探测不到消息表时给出明确错误码', async () => {
  const dir = await mkdtemp(join(ROOT, '.tmp-convert-'));
  const path = join(dir, 'plain.db');
  try {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE Whatever (a TEXT)');
    db.close();

    assert.throws(
      () => convertDatabase(path, { outRoot: join(dir, 'o') }),
      (err) => err.code === 'SCHEMA_NOT_RECOGNIZED',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件不存在 → DB_NOT_FOUND', () => {
  assert.throws(
    () => convertDatabase(join(ROOT, 'nope.db'), { outRoot: join(ROOT, 'o') }),
    (err) => err.code === 'DB_NOT_FOUND',
  );
});

test('detectSchema 能列出候选并挑行数最多的', async () => {
  const { dir, path } = await makeDb();
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    const { candidates } = detectSchema(db);
    db.close();
    assert.equal(candidates[0].table, 'Msg_abc');
    assert.equal(candidates[0].rowCount, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('formatTime 处理秒/毫秒/字符串', () => {
  // 1762737120 = 2025-11-10T01:12:00Z → Asia/Shanghai 09:12
  assert.equal(formatTime(1762737120), '2025-11-10 09:12');
  assert.equal(formatTime(1762737120000), '2025-11-10 09:12');
  assert.equal(formatTime('2026-11-10T01:12:00Z'), '2026-11-10 09:12');
  assert.equal(formatTime(null), '');
  assert.equal(formatTime('不是时间'), '不是时间');
});
