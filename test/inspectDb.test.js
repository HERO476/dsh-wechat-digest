import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { inspectDatabase } from '../scripts/inspect-db.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('能读出表名、行数与列名', async () => {
  const dir = await mkdtemp(join(ROOT, '.tmp-db-'));
  const path = join(dir, 'sample.db');
  try {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE Msg_abc (talker TEXT, create_time INTEGER, content TEXT)');
    db.exec("CREATE TABLE Name2Id (user_name TEXT)");
    db.prepare('INSERT INTO Msg_abc (talker, create_time, content) VALUES (?, ?, ?)').run(
      '123@chatroom',
      1700000000,
      'hello',
    );
    db.prepare('INSERT INTO Msg_abc (talker, create_time, content) VALUES (?, ?, ?)').run(
      'wxid_x',
      1700000001,
      'hi',
    );
    db.close();

    const report = inspectDatabase(path);
    const byName = Object.fromEntries(report.tables.map((table) => [table.table, table]));

    assert.equal(report.objectCount, 2);
    assert.equal(byName.Msg_abc.rowCount, 2);
    assert.deepEqual(
      byName.Msg_abc.columns.map((column) => column.name),
      ['talker', 'create_time', 'content'],
    );
    assert.equal(byName.Name2Id.rowCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件不存在时给出明确错误码', () => {
  assert.throws(
    () => inspectDatabase(join(ROOT, 'no-such-db.sqlite')),
    (err) => err.code === 'DB_NOT_FOUND',
  );
});
