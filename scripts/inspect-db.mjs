#!/usr/bin/env node
/**
 * 解密库结构探查：读一个**已经解密**的 SQLite 库，打印表名、行数、列名。
 *
 * 用途：微信 4.x 的 message 表到底有哪些列、会话标识字段叫什么，公开资料说法不一，
 * 而密文库里看不到。因此第一步不是猜，是把真实 schema 打出来，再据此写映射。
 *
 * 跑法：
 *   node scripts/inspect-db.mjs <解密后的.db>
 *
 * 注意：本脚本只读，且**不负责解密**。解密需要沙箱外的取密钥组件（见 docs/PHASE2.md）。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

export function inspectDatabase(path) {
  if (!existsSync(path)) {
    const err = new Error(`文件不存在: ${path}`);
    err.code = 'DB_NOT_FOUND';
    throw err;
  }

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const objects = db
      .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name")
      .all();

    const tables = objects.map((object) => {
      let rowCount = null;
      try {
        rowCount = db.prepare(`SELECT COUNT(*) AS n FROM "${object.name}"`).get().n;
      } catch {
        rowCount = null;
      }

      let columns = [];
      try {
        columns = db.prepare(`PRAGMA table_info("${object.name}")`).all().map((column) => ({
          name: column.name,
          type: column.type ?? null,
        }));
      } catch {
        columns = [];
      }

      return { type: object.type, table: object.name, rowCount, columns };
    });

    return { path, objectCount: tables.length, tables };
  } finally {
    db.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('inspect-db.mjs')) {
  const target = process.argv[2];
  if (!target) {
    console.error('用法：node scripts/inspect-db.mjs <解密后的.db>');
    process.exit(1);
  }
  try {
    const report = inspectDatabase(target);
    console.log(`== ${report.path} ==`);
    console.log(`  对象数：${report.objectCount}`);
    for (const table of report.tables) {
      console.log(`\n  [${table.type}] ${table.table}  行数=${table.rowCount ?? '?'}`);
      console.log(`    列：${table.columns.map((column) => column.name).join(', ') || '(无)'}`);
    }
  } catch (err) {
    console.error(`探查失败：${err.code ?? 'UNKNOWN'} — ${err.message}`);
    process.exitCode = 1;
  }
}
