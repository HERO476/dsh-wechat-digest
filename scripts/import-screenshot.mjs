#!/usr/bin/env node
/**
 * 把「聊天截图」变成插件能读的导出数据。
 *
 * 为什么要它：微信 4.x 的库是加密的，第三方解密工具已被官方要求下架；
 * 直接读进程内存会拖累账号（本机已因此被限制过一次）。剩下的干净做法是：
 *   **你截图（官方客户端里正常看），我只做识别与入库。**
 *
 * 用法：
 *   node scripts/import-screenshot.mjs shot.png --room 产品评审群
 *   node scripts/import-screenshot.mjs a.png b.png --room 产品评审群 --append
 *   node scripts/import-screenshot.mjs shot.png --room 某人 --kind private
 *
 * 输出：<exportRoot>/<slug>/room.json + messages.txt
 * 副作用：只在 exports/ 下写文件；不碰微信进程、不联网、不打印聊天内容。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOcrLines, toMessagesText, dedupe } from '../src/ocr-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PS1 = join(HERE, 'ocr-screenshot.ps1');

const SAFE_SLUG = /^[a-z0-9_-]{1,64}$/i;

function usage(code = 0) {
  const msg = [
    '用法: node scripts/import-screenshot.mjs <图片...> --room <会话名> [--slug xx] [--kind group|private] [--append] [--out <dir>]',
    '',
    '  --room    会话名（会写进 room.json 的 name，可用中文）',
    '  --slug    目录名（只用字母数字下划线；不给则自动生成）',
    '  --kind    group（默认）或 private',
    '  --append  追加到已有 messages.txt（默认覆盖）',
    '  --out     导出根目录（默认 <仓库>/exports，可用 WECHAT_DIGEST_EXPORT_DIR 覆盖）',
    '  --date    YYYY-MM-DD：把 OCR 里残缺的日期补全',
    '  --scale   1|2|3：OCR 前放大倍数（默认 2）',
    '  --invert  0|1|auto：反色（默认 0）',
  ].join('\n');
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const images = [];
  const opts = { room: null, slug: null, kind: 'group', append: false, out: null, date: '', scale: 2, invert: '0' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--room') opts.room = argv[++i];
    else if (arg === '--slug') opts.slug = argv[++i];
    else if (arg === '--kind') opts.kind = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--scale') opts.scale = Number(argv[++i]);
    else if (arg === '--invert') opts.invert = argv[++i];
    else if (arg === '--append') opts.append = true;
    else if (arg === '-h' || arg === '--help') usage(0);
    else if (arg.startsWith('--')) usage(2);
    else images.push(arg);
  }

  return { images, opts };
}

function slugFor(name, explicit) {
  if (explicit) {
    if (!SAFE_SLUG.test(explicit)) {
      throw Object.assign(new Error('BAD_SLUG: 只能字母数字下划线连字符，1-64 位'), { code: 'BAD_SLUG' });
    }
    return explicit;
  }
  // 中文名没法直接当目录名：生成稳定短哈希，名字本身写进 room.json
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `ocr-${h.toString(36)}`;
}

function ocrImage(imagePath, { scale = 2, invert = '0' } = {}) {
  const abs = resolve(imagePath);
  if (!existsSync(abs)) {
    throw Object.assign(new Error(`IMAGE_NOT_FOUND: ${abs}`), { code: 'IMAGE_NOT_FOUND' });
  }

  const out = abs.replace(/\.[^.]+$/, '') + '.ocr.json';
  const stdout = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      PS1,
      '-ImagePath',
      abs,
      '-OutPath',
      out,
      '-Scale',
      String(Math.min(3, Math.max(1, Number(scale) || 2))),
      '-Invert',
      invert,
    ],
    { encoding: 'utf8' },
  );

  if (/^ERR/m.test(stdout) || !existsSync(out)) {
    throw Object.assign(new Error(`OCR_FAILED: ${String(stdout).trim()}`), { code: 'OCR_FAILED' });
  }

  const payload = JSON.parse(readFileSync(out, 'utf8').replace(/^\uFEFF/, ''));
  return { payload, jsonPath: out };
}

function readExisting(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\[([^\]]*)\]\s*([^:：]+)[:：]\s*(.*)$/.exec(line.trim());
    if (m) rows.push({ at: m[1], sender: m[2].trim(), text: m[3] });
  }
  return rows;
}

function main() {
  const { images, opts } = parseArgs(process.argv.slice(2));

  if (images.length === 0) usage(2);
  if (!opts.room || opts.room.trim().length === 0) usage(2);
  if (opts.kind !== 'group' && opts.kind !== 'private') {
    process.stderr.write('--kind 只能是 group 或 private\n');
    process.exit(2);
  }

  const exportRoot = opts.out ?? process.env.WECHAT_DIGEST_EXPORT_DIR ?? join(ROOT, 'exports');
  const slug = slugFor(opts.room, opts.slug);
  const roomDir = join(exportRoot, slug);
  mkdirSync(roomDir, { recursive: true });

  const all = [];
  let warnings = [];
  let totalLines = 0;

  for (const image of images) {
    const { payload } = ocrImage(image, { scale: opts.scale, invert: opts.invert });
    totalLines += payload.lines?.length ?? 0;
    const parsed = parseOcrLines(payload.lines, { pageWidth: payload.pageWidth ?? 0, baseDate: opts.date || '' });
    all.push(...parsed.messages);
    warnings = warnings.concat(parsed.warnings);
  }

  const merged = opts.append ? dedupe([...readExisting(join(roomDir, 'messages.txt')), ...all]) : dedupe(all);

  const roomJson = { name: opts.room.trim(), kind: opts.kind, id: slug };
  writeFileSync(join(roomDir, 'room.json'), `${JSON.stringify(roomJson, null, 2)}\n`, 'utf8');
  writeFileSync(join(roomDir, 'messages.txt'), toMessagesText(merged), 'utf8');

  // 只报计数与路径，不打印聊天内容
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        room: roomJson.name,
        kind: roomJson.kind,
        dir: roomDir,
        images: images.length,
        ocrLines: totalLines,
        messages: merged.length,
        appended: opts.append,
        warnings: warnings.slice(0, 5),
      },
      null,
      2,
    )}\n`,
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err?.code ?? 'ERROR'}: ${err?.message ?? err}\n`);
  process.exit(1);
}
