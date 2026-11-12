#!/usr/bin/env node
/**
 * 自动采集：自己找到微信窗口 → 截图 → OCR → 去重追加到 exports/。
 *
 * 与 import-screenshot.mjs 的区别：那个要你手动给图；这个定时自己截。
 *
 * 能力边界（刻意如此）：
 *  - **只取像素**（PrintWindow），不读进程内存、不解密数据库、不发消息；
 *  - **不模拟输入**：不自动滚动、不自动点击。要看更早的消息，你自己在微信里滚，
 *    下一轮采集会自动把新露出来的内容追加上去（内容级去重）。
 *
 * 用法：
 *   node scripts/watch-wechat.mjs --room 产品评审群            # 每 20 秒采一屏
 *   node scripts/watch-wechat.mjs --room 产品评审群 --once      # 只采一屏
 *   node scripts/watch-wechat.mjs --room 产品评审群 --interval 8 --kind private
 *
 * 只打印计数（帧数/新增条数/告警数），**不打印聊天内容**。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { parseOcrLines, toMessagesText, dedupe } from '../src/ocr-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CAPTURE_PS1 = join(HERE, 'capture-window.ps1');
const OCR_PS1 = join(HERE, 'ocr-screenshot.ps1');

const SAFE_SLUG = /^[a-z0-9_-]{1,64}$/i;

function usage(code = 0) {
  const msg = [
    '用法: node scripts/watch-wechat.mjs --room <会话名> [--slug xx] [--kind group|private] [--interval 20] [--once] [--out dir]',
    '',
    '  --room      会话名（写入 room.json）',
    '  --interval  采集间隔秒数（默认 20，最小 5）',
    '  --once      只采一屏就退出',
    '  --kind      group（默认）/ private',
    '  --out       导出根目录（默认 <仓库>/exports）',
  ].join('\n');
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { room: null, slug: null, kind: 'group', interval: 20, once: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--room') opts.room = argv[++i];
    else if (a === '--slug') opts.slug = argv[++i];
    else if (a === '--kind') opts.kind = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--interval') opts.interval = Number(argv[++i]);
    else if (a === '--once') opts.once = true;
    else if (a === '-h' || a === '--help') usage(0);
    else usage(2);
  }
  return opts;
}

function slugFor(name, explicit) {
  if (explicit) {
    if (!SAFE_SLUG.test(explicit)) {
      throw Object.assign(new Error('BAD_SLUG'), { code: 'BAD_SLUG' });
    }
    return explicit;
  }
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `ocr-${h.toString(36)}`;
}

function ps(script, args) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8',
  });
}

function capture(shotPath) {
  const metaPath = `${shotPath}.meta.txt`;
  try {
    rmSync(metaPath, { force: true });
  } catch {
    /* ignore */
  }
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE_PS1, '-OutPath', shotPath],
    { encoding: 'utf8' },
  );

  if (!existsSync(metaPath)) {
    throw Object.assign(new Error('CAPTURE_FAILED: 没有状态文件'), { code: 'CAPTURE_FAILED' });
  }
  const meta = readFileSync(metaPath, 'utf8').trim();
  if (meta.startsWith('ERR')) {
    const code = /code=([A-Z_]+)/.exec(meta)?.[1] ?? 'CAPTURE_FAILED';
    throw Object.assign(new Error(`CAPTURE_FAILED: ${meta}`), { code });
  }
  const m = /size=(\d+)x(\d+)/.exec(meta);
  return { width: m ? Number(m[1]) : 0, height: m ? Number(m[2]) : 0, raw: meta };
}

function ocr(shotPath, jsonPath) {
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1, '-ImagePath', shotPath, '-OutPath', jsonPath],
    { encoding: 'utf8' },
  );
  if (!existsSync(jsonPath)) {
    throw Object.assign(new Error('OCR_FAILED: 没有输出 JSON'), { code: 'OCR_FAILED' });
  }
  const payload = JSON.parse(readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));
  return payload;
}

function readExisting(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\[([^\]]*)\]\s*([^:：]+)[:：]\s*(.*)$/.exec(line.trim());
    if (m) rows.push({ at: m[1], sender: m[2].trim(), text: m[3] });
  }
  return rows;
}

/** 只保留计数，避免把聊天内容打到终端/日志里。 */
function summarize(parsed) {
  return { messages: parsed.messages.length, warnings: parsed.warnings.length };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.room) usage(2);
  if (opts.kind !== 'group' && opts.kind !== 'private') usage(2);

  const intervalSec = Math.max(5, Number.isFinite(opts.interval) ? opts.interval : 20);
  const exportRoot = opts.out ?? process.env.WECHAT_DIGEST_EXPORT_DIR ?? join(ROOT, 'exports');
  const slug = slugFor(opts.room, opts.slug);
  const roomDir = join(exportRoot, slug);
  mkdirSync(roomDir, { recursive: true });

  const roomJson = { name: opts.room.trim(), kind: opts.kind, id: slug };
  writeFileSync(join(roomDir, 'room.json'), `${JSON.stringify(roomJson, null, 2)}\n`, 'utf8');

  const work = join(tmpdir(), `dsh-wechat-watch-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const shot = join(work, 'shot.png');
  const json = join(work, 'shot.ocr.json');
  const messagesFile = join(roomDir, 'messages.txt');

  let frames = 0;
  let added = 0;
  let lastSize = '';

  const tick = () => {
    frames += 1;
    let meta;
    try {
      meta = capture(shot);
    } catch (err) {
      process.stdout.write(`[${frames}] capture: ${err.code ?? 'ERROR'}（微信窗口没打开或在最小化）\n`);
      return;
    }

    const sizeTag = `${meta.width}x${meta.height}`;
    if (sizeTag !== lastSize) lastSize = sizeTag;

    let payload;
    try {
      payload = ocr(shot, json);
    } catch (err) {
      process.stdout.write(`[${frames}] ocr: ${err.code ?? 'ERROR'}\n`);
      return;
    }

    const parsed = parseOcrLines(payload.lines, { pageWidth: payload.pageWidth ?? 0 });
    const before = readExisting(messagesFile);
    const merged = dedupe([...before, ...parsed.messages]);
    const delta = merged.length - before.length;

    if (delta > 0 || !existsSync(messagesFile)) {
      writeFileSync(messagesFile, toMessagesText(merged), 'utf8');
      added += delta;
    }

    const s = summarize(parsed);
    process.stdout.write(
      `[${frames}] ${sizeTag} ocrLines=${payload.lines?.length ?? 0} parsed=${s.messages} +${delta} total=${merged.length} warn=${s.warnings}\n`,
    );
  };

  process.stdout.write(
    `采集目标: ${roomJson.name} (${roomJson.kind}) -> ${roomDir}\n间隔 ${intervalSec}s；不模拟输入、不读内存；Ctrl+C 结束\n`,
  );

  if (opts.once) {
    tick();
    cleanup();
    process.stdout.write(`完成：帧 1，新增 ${added} 条，累计 ${readExisting(messagesFile).length} 条\n`);
    return;
  }

  tick();
  const timer = setInterval(tick, intervalSec * 1000);
  if (typeof timer.unref === 'function') timer.unref();

  const stop = () => {
    clearInterval(timer);
    cleanup();
    process.stdout.write(`\n停止：帧 ${frames}，新增 ${added} 条，累计 ${readExisting(messagesFile).length} 条\n`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  function cleanup() {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err?.code ?? 'ERROR'}: ${err?.message ?? err}\n`);
  process.exit(1);
}
