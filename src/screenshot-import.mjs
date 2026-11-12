/**
 * 截图 → OCR → exports/ 的共享实现。
 *
 * CLI（scripts/import-screenshot.mjs）与设置页（src/settings-api.js）都调这里，
 * 避免两份逻辑慢慢长歪。OCR 调用可注入，测试时不需要真的起 PowerShell。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOcrLines, toMessagesText, dedupe } from './ocr-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
export const OCR_SCRIPT = join(ROOT, 'scripts', 'ocr-screenshot.ps1');

const SAFE_SLUG = /^[a-z0-9_-]{1,64}$/i;
const MAX_ROOM_NAME = 120;

/** 中文房间名没法直接做目录名：生成稳定短哈希；名字本身写进 room.json。 */
export function slugFor(name, explicit) {
  if (explicit) {
    if (!SAFE_SLUG.test(explicit)) {
      throw Object.assign(new Error('BAD_SLUG: 只能字母数字下划线连字符，1-64 位'), { code: 'BAD_SLUG' });
    }
    return explicit;
  }
  let h = 2166136261;
  const text = String(name ?? '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `ocr-${h.toString(36)}`;
}

/** 默认 OCR 执行器：调 Windows 内置 OCR（PowerShell 脚本）。 */
export function runWindowsOcr({ imagePath, outPath, scale = 2, invert = '0' }) {
  const stdout = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      OCR_SCRIPT,
      '-ImagePath',
      imagePath,
      '-OutPath',
      outPath,
      '-Scale',
      String(Math.min(3, Math.max(1, Number(scale) || 2))),
      '-Invert',
      String(invert ?? '0'),
    ],
    { encoding: 'utf8' },
  );

  const text = String(stdout ?? '').trim();
  const err = /^ERR\s+(.*)$/m.exec(text);
  if (err) {
    const code = /code=([A-Z_]+)/.exec(err[1])?.[1] ?? 'OCR_FAILED';
    throw Object.assign(new Error(err[1]), { code });
  }
  if (!existsSync(outPath)) {
    throw Object.assign(new Error('OCR_FAILED: 没有输出 JSON'), { code: 'OCR_FAILED' });
  }
  return JSON.parse(readFileSync(outPath, 'utf8').replace(/^\uFEFF/, ''));
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

/**
 * @param {{
 *   imagePath: string,
 *   room: string,
 *   kind?: 'group'|'private',
 *   slug?: string,
 *   date?: string,
 *   exportDir: string,
 *   scale?: number,
 *   invert?: string,
 *   append?: boolean,
 *   runner?: Function,
 * }} options
 */
export function importScreenshot(options = {}) {
  const {
    imagePath,
    room,
    kind = 'group',
    slug: explicitSlug,
    date = '',
    exportDir,
    scale = 2,
    invert = '0',
    append = false,
    runner = runWindowsOcr,
  } = options;

  if (!imagePath || !existsSync(imagePath)) {
    throw Object.assign(new Error(`IMAGE_NOT_FOUND: ${imagePath ?? '(空)'}`), { code: 'IMAGE_NOT_FOUND' });
  }
  if (typeof room !== 'string' || room.trim().length === 0) {
    throw Object.assign(new Error('ROOM_REQUIRED'), { code: 'ROOM_REQUIRED' });
  }
  if (room.trim().length > MAX_ROOM_NAME) {
    throw Object.assign(new Error('ROOM_NAME_TOO_LONG'), { code: 'ROOM_NAME_TOO_LONG' });
  }
  if (kind !== 'group' && kind !== 'private') {
    throw Object.assign(new Error('BAD_KIND'), { code: 'BAD_KIND' });
  }
  if (!exportDir) {
    throw Object.assign(new Error('EXPORT_DIR_REQUIRED'), { code: 'EXPORT_DIR_REQUIRED' });
  }

  const slug = slugFor(room.trim(), explicitSlug);
  const roomDir = join(exportDir, slug);
  mkdirSync(roomDir, { recursive: true });

  const jsonPath = `${imagePath}.ocr.json`;
  const payload = runner({ imagePath, outPath: jsonPath, scale, invert });

  const parsed = parseOcrLines(payload.lines, {
    pageWidth: payload.pageWidth ?? 0,
    baseDate: date || '',
  });

  const messagesFile = join(roomDir, 'messages.txt');
  const merged = append ? dedupe([...readExisting(messagesFile), ...parsed.messages]) : dedupe(parsed.messages);

  writeFileSync(
    join(roomDir, 'room.json'),
    `${JSON.stringify({ name: room.trim(), kind, id: slug }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(messagesFile, toMessagesText(merged), 'utf8');

  return {
    room: room.trim(),
    kind,
    slug,
    dir: roomDir,
    ocrLines: payload.lines?.length ?? 0,
    messages: merged.length,
    warnings: parsed.warnings,
  };
}
