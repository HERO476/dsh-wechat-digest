#!/usr/bin/env node
/**
 * 解密库 → 本项目导出格式 的转换器。
 *
 * 前置：你得先在**沙箱外**用你信任的工具把微信库解密好（本项目不做解密）。
 *
 * 安全决策（重要）：导出层没有策略闸门，所以**只在源头导出群聊**——
 * talker 必须以 @chatroom 结尾，否则连文件都不生成。私聊不是"被过滤"，是"从未被写出"。
 *
 * 用法：
 *   node scripts/convert-decrypted-db.mjs <解密后的.db> <输出目录> --dry-run   先看 detect 结果
 *   node scripts/convert-decrypted-db.mjs <解密后的.db> <输出目录>              真正转换
 *
 * 真实微信 4.x 的列名与本脚本的启发式探测可能不一致；
 * 请先 --dry-run 看清探测到的表与列，再决定是否 --apply。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TALKER_RE = /^(talker|username|str_talker|user_name|session)$/i;
const CONTENT_RE = /(content|message|msg|text)/i;
const TIME_RE = /(create_?time|createtime|timestamp|sort_seq|time)/i;
const SENDER_RE = /(is_sender|is_self|sender|from_user|real_sender)/i;

const SAFE_SLUG = /^[a-z0-9_-]{1,64}$/i;
const CHATROOM_SUFFIX = '@chatroom';

function sha1(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 秒 / 毫秒 / ISO 字符串统一成 Asia/Shanghai 的 YYYY-MM-DD HH:MM。 */
export function formatTime(value) {
  if (value === null || value === undefined || value === '') return '';
  let ms;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    ms = numeric > 1e12 ? numeric : numeric * 1000;
  } else {
    const parsed = Date.parse(String(value));
    if (Number.isNaN(parsed)) return String(value);
    ms = parsed;
  }
  const shifted = new Date(ms + 8 * 3600 * 1000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(
    shifted.getUTCHours(),
  )}:${pad(shifted.getUTCMinutes())}`;
}

function tableInfo(db, name) {
  return db.prepare(`PRAGMA table_info("${name}")`).all().map((column) => column.name);
}

/** 找出最像"消息表"的表，返回表名与关键列。 */
export function detectSchema(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);

  const candidates = [];

  for (const table of tables) {
    const columns = tableInfo(db, table);
    const talkerCol = columns.find((column) => TALKER_RE.test(column));
    if (!talkerCol) continue;

    const contentCol = columns.find((column) => CONTENT_RE.test(column) && !TALKER_RE.test(column));
    if (!contentCol) continue;

    let rowCount = 0;
    try {
      rowCount = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    } catch {
      rowCount = 0;
    }

    candidates.push({
      table,
      columns,
      talkerCol,
      contentCol,
      timeCol: columns.find((column) => TIME_RE.test(column)) ?? null,
      senderCol: columns.find((column) => SENDER_RE.test(column)) ?? null,
      rowCount,
    });
  }

  candidates.sort((a, b) => b.rowCount - a.rowCount);
  return { tables, candidates };
}

function toSlug(talker) {
  const bare = talker.endsWith(CHATROOM_SUFFIX) ? talker.slice(0, -CHATROOM_SUFFIX.length) : talker;
  return SAFE_SLUG.test(bare) ? bare : sha1(talker);
}

function cellToText(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return { unsupported: 'BINARY_OR_COMPRESSED' };
  const text = String(value);
  return text.trim().length > 0 ? text : null;
}

/**
 * @returns {Promise<{dryRun:boolean, schema:object, rooms:Array, skipped:{binary:number, empty:number}}>}
 */
export function convertDatabase(dbPath, { outRoot, dryRun = false, limitPerRoom = 5000 } = {}) {
  if (!existsSync(dbPath)) {
    const err = new Error(`文件不存在: ${dbPath}`);
    err.code = 'DB_NOT_FOUND';
    throw err;
  }
  if (!dryRun && !outRoot) {
    const err = new Error('缺少输出目录');
    err.code = 'OUTPUT_REQUIRED';
    throw err;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const { tables, candidates } = detectSchema(db);
    if (candidates.length === 0) {
      const err = new Error('没有找到同时含"会话标识"与"消息内容"列的表');
      err.code = 'SCHEMA_NOT_RECOGNIZED';
      err.details = { tables };
      throw err;
    }

    const best = candidates[0];
    const talkers = db
      .prepare(`SELECT DISTINCT "${best.talkerCol}" AS t FROM "${best.table}" WHERE "${best.talkerCol}" LIKE ?`)
      .all(`%${CHATROOM_SUFFIX}`)
      .map((row) => String(row.t))
      .filter((talker) => talker.endsWith(CHATROOM_SUFFIX));

    const orderBy = best.timeCol ? `ORDER BY "${best.timeCol}" ASC` : '';
    const selectColumns = [best.talkerCol, best.contentCol, best.timeCol, best.senderCol]
      .filter(Boolean)
      .map((column) => `"${column}"`)
      .join(', ');

    const rooms = [];
    const skipped = { binary: 0, empty: 0 };

    for (const talker of talkers) {
      const rows = db
        .prepare(`SELECT ${selectColumns} FROM "${best.table}" WHERE "${best.talkerCol}" = ? ${orderBy} LIMIT ?`)
        .all(talker, limitPerRoom);

      const lines = [];

      for (const row of rows) {
        const content = cellToText(row[best.contentCol]);
        if (content === null) {
          skipped.empty += 1;
          continue;
        }
        if (typeof content === 'object') {
          skipped.binary += 1;
          continue;
        }

        const isSelf = best.senderCol ? Number(row[best.senderCol]) === 1 : false;
        const sender = isSelf ? '我' : '群成员';
        const time = best.timeCol ? formatTime(row[best.timeCol]) : '';
        lines.push(`[${time}] ${sender}: ${content}`);
      }

      const slug = toSlug(talker);
      rooms.push({
        talker,
        slug,
        name: `群 ${slug}`,
        lineCount: lines.length,
        skippedBinary: rows.length - lines.length,
      });

      if (!dryRun && lines.length > 0) {
        const dir = join(outRoot, slug);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'room.json'),
          `${JSON.stringify({ name: `群 ${slug}`, kind: 'group', id: slug }, null, 2)}\n`,
          'utf8',
        );
        writeFileSync(join(dir, 'messages.txt'), `${lines.join('\n')}\n`, 'utf8');
      }
    }

    return {
      dryRun,
      schema: {
        table: best.table,
        talkerCol: best.talkerCol,
        contentCol: best.contentCol,
        timeCol: best.timeCol,
        senderCol: best.senderCol,
        rowCount: best.rowCount,
        otherCandidates: candidates.slice(1).map((item) => item.table),
      },
      rooms,
      skipped,
    };
  } finally {
    db.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('convert-decrypted-db.mjs')) {
  const [, , dbPath, outRoot, ...flags] = process.argv;
  const dryRun = flags.includes('--dry-run') || !outRoot;

  if (!dbPath) {
    console.error('用法：node scripts/convert-decrypted-db.mjs <解密后的.db> [输出目录] [--dry-run]');
    process.exit(1);
  }

  try {
    const report = convertDatabase(dbPath, { outRoot, dryRun });
    console.log(`模式：${report.dryRun ? 'DRY-RUN（不写文件）' : '正式转换'}`);
    console.log(`探测到消息表：${report.schema.table}（${report.schema.rowCount} 行）`);
    console.log(`  会话列 ${report.schema.talkerCol} ｜ 内容列 ${report.schema.contentCol} ｜ 时间列 ${report.schema.timeCol ?? '(无)'} ｜ 发送者列 ${report.schema.senderCol ?? '(无)'}`);
    if (report.schema.otherCandidates.length > 0) {
      console.log(`  其它候选表：${report.schema.otherCandidates.join(', ')}`);
    }
    console.log(`\n群聊会话 ${report.rooms.length} 个（私聊不会被导出）：`);
    for (const room of report.rooms) {
      console.log(`  ${room.slug}  ${room.lineCount} 条${room.skippedBinary > 0 ? `（跳过 ${room.skippedBinary} 条二进制/压缩）` : ''}`);
    }
    if (report.skipped.binary > 0) {
      console.log(`\n注意：有 ${report.skipped.binary} 条内容是二进制或压缩（4.x 常见 compress_content），本版未实现解码，已跳过。`);
    }
    if (report.dryRun) console.log('\n这是 DRY-RUN，未写入任何文件。确认上面映射无误后，去掉 --dry-run 再跑。');
  } catch (err) {
    console.error(`转换失败：${err.code ?? 'UNKNOWN'} — ${err.message}`);
    if (err.code === 'SCHEMA_NOT_RECOGNIZED') {
      console.error('请先跑 node scripts/inspect-db.mjs <db> 看清表结构，再把列名告诉我。');
    }
    process.exitCode = 1;
  }
}
