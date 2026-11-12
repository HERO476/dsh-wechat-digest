#!/usr/bin/env node
/**
 * 自动采集：定位微信窗口 → 屏幕像素拷贝 → OCR → 解析 → 去重追加 exports/。
 *
 * 能力边界（刻意如此）：
 *  - **只取屏幕像素**（CopyFromScreen），不读进程内存、不解密数据库、不发消息；
 *  - **不模拟输入**：不自动滚动、不自动点击。要看更早的消息，你自己往上滚，
 *    下一轮采集会把新露出的内容按内容去重追加。
 *
 * 用法：
 *   node scripts/watch-wechat.mjs --room 产品评审群                 # 每 20 秒一屏
 *   node scripts/watch-wechat.mjs --room 产品评审群 --once           # 只采一屏
 *   node scripts/watch-wechat.mjs --room 产品评审群 --date 2026-11-12 --scale 2
 *   node scripts/watch-wechat.mjs --room 产品评审群 --max-frames 30 --interval 10
 *
 * 只打印计数（帧数/行数/新增条数），**不打印聊天内容**。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { parseOcrLines, toMessagesText, dedupe } from '../src/ocr-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CAPTURE_PS1 = join(HERE, 'capture-window.ps1');
const OCR_PS1 = join(HERE, 'ocr-screenshot.ps1');

const SAFE_SLUG = /^[a-z0-9_-]{1,64}$/i;

/** 把脚本返回的错误码翻成人话（脚本本身必须纯 ASCII）。 */
const CODE_HINT = {
  NO_PROCESS: '微信电脑端没在运行',
  NO_WINDOW: '微信没有可见窗口',
  MINIMIZED: '微信窗口被最小化了：请点开主窗口（不要最小化）',
  WINDOW_TOO_SMALL: '可见窗口太小：请打开主窗口/聊天窗口（登录态）',
  NO_RECT: '取不到窗口位置',
  OCR_ENGINE_UNAVAILABLE: '本机缺中文 OCR 语言包',
  CAPTURE_FAILED: '截屏失败',
  OCR_FAILED: 'OCR 失败',
};

function usage(code = 0) {
  const msg = [
    '用法: node scripts/watch-wechat.mjs --room <会话名> [options]',
    '',
    '  --room <名字>      会话名（写入 room.json，可中文）',
    '  --slug <名字>      目录名（字母数字下划线；默认按房间名生成稳定哈希）',
    '  --kind group|private',
    '  --interval <秒>    采集间隔（默认 20，最小 5）',
    '  --max-frames <n>   采满 n 帧后自动结束（默认不限制）',
    '  --once             只采一屏',
    '  --date YYYY-MM-DD  当前日期：把 OCR 里残缺的日期补全',
    '  --scale 1|2|3      OCR 前放大倍数（默认 2，对小字更友好）',
    '  --invert 0|1|auto  反色（默认 0；实测深色截图不反色也能识别，异常时可试 1）',
    '  --scroll <n>       每帧后向上滚 n 格（默认 0 = 不滚）。**会产生鼠标滚轮输入**，',
    '                     只在微信位于前台时执行；这是本工具唯一模拟输入的地方，慎用',
    '  --out <目录>       导出根目录（默认 <仓库>/exports）',
  ].join('\n');
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = {
    room: null,
    slug: null,
    kind: 'group',
    interval: 20,
    maxFrames: 0,
    once: false,
    date: '',
    scale: 2,
    invert: '0',
    scroll: 0,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--room') o.room = argv[++i];
    else if (a === '--slug') o.slug = argv[++i];
    else if (a === '--kind') o.kind = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--date') o.date = argv[++i];
    else if (a === '--invert') o.invert = argv[++i];
    else if (a === '--scroll') o.scroll = Number(argv[++i]);
    else if (a === '--interval') o.interval = Number(argv[++i]);
    else if (a === '--max-frames') o.maxFrames = Number(argv[++i]);
    else if (a === '--scale') o.scale = Number(argv[++i]);
    else if (a === '--once') o.once = true;
    else if (a === '-h' || a === '--help') usage(0);
    else usage(2);
  }
  return o;
}

function slugFor(name, explicit) {
  if (explicit) {
    if (!SAFE_SLUG.test(explicit)) throw Object.assign(new Error('BAD_SLUG'), { code: 'BAD_SLUG' });
    return explicit;
  }
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `ocr-${h.toString(36)}`;
}

function runPs(script, args) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8' },
  );
}

function capture(shotPath, scrollClicks = 0) {
  const stdout = runPs(CAPTURE_PS1, ['-OutPath', shotPath, '-ScrollClicks', String(scrollClicks)]);
  const text = String(stdout ?? '').trim();

  const err = /^ERR\s+(.*)$/m.exec(text);
  if (err) {
    const code = /code=([A-Z_]+)/.exec(err[1])?.[1] ?? 'CAPTURE_FAILED';
    const size = /size=(\d+x\d+)/.exec(err[1])?.[1] ?? '';
    throw Object.assign(new Error(err[1]), { code, size });
  }

  // 请求了滚动但窗口不在前台：截图仍然有效，只是没滚
  const warn = /^WARN\s+code=([A-Z_]+)/m.exec(text);
  if (warn) {
    const size = /size=(\d+)x(\d+)/.exec(text);
    return {
      width: size ? Number(size[1]) : 0,
      height: size ? Number(size[2]) : 0,
      foreground: false,
      scrollSkipped: true,
      warnCode: warn[1],
    };
  }

  if (!/^OK/m.test(text) || !existsSync(shotPath)) {
    throw Object.assign(new Error(`CAPTURE_FAILED: ${text.slice(0, 120)}`), { code: 'CAPTURE_FAILED' });
  }

  const size = /size=(\d+)x(\d+)/.exec(text);
  const fg = /fg=(\d)/.exec(text);
  const scrolled = /scrolled=(\d+)/.exec(text);
  return {
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    foreground: fg ? fg[1] === '1' : false,
    scrollSkipped: false,
    scrolled: scrolled ? Number(scrolled[1]) : 0,
  };
}

function ocr(shotPath, jsonPath, scale, invert = 'auto') {
  const stdout = runPs(OCR_PS1, [
    '-ImagePath',
    shotPath,
    '-OutPath',
    jsonPath,
    '-Scale',
    String(Math.min(3, Math.max(1, scale || 2))),
    '-Invert',
    invert,
  ]);
  const err = /^ERR\s+(.*)$/m.exec(String(stdout ?? '').trim());
  if (err) {
    const code = /code=([A-Z_]+)/.exec(err[1])?.[1] ?? 'OCR_FAILED';
    throw Object.assign(new Error(err[1]), { code });
  }
  if (!existsSync(jsonPath)) {
    throw Object.assign(new Error('OCR_FAILED: 没有输出 JSON'), { code: 'OCR_FAILED' });
  }
  return JSON.parse(readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));
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

function frameHash(shotPath) {
  try {
    return createHash('sha1').update(readFileSync(shotPath)).digest('hex');
  } catch {
    return null;
  }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.room) usage(2);
  if (o.kind !== 'group' && o.kind !== 'private') usage(2);

  const intervalSec = Math.max(5, Number.isFinite(o.interval) ? o.interval : 20);
  const maxFrames = Number.isFinite(o.maxFrames) && o.maxFrames > 0 ? o.maxFrames : 0;
  const exportRoot = o.out ?? process.env.WECHAT_DIGEST_EXPORT_DIR ?? join(ROOT, 'exports');
  const slug = slugFor(o.room, o.slug);
  const roomDir = join(exportRoot, slug);
  mkdirSync(roomDir, { recursive: true });

  const roomJson = { name: o.room.trim(), kind: o.kind, id: slug };
  writeFileSync(join(roomDir, 'room.json'), `${JSON.stringify(roomJson, null, 2)}\n`, 'utf8');
  const messagesFile = join(roomDir, 'messages.txt');

  const work = join(tmpdir(), `dsh-wechat-watch-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const shot = join(work, 'shot.png');
  const json = join(work, 'shot.ocr.json');

  const stats = { frames: 0, skipped: 0, ocrLines: 0, added: 0, warnings: 0, errors: 0 };
  let lastHash = null;
  let coveredWarned = false;

  const cleanup = () => {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  const tick = () => {
    stats.frames += 1;
    const tag = `[${stats.frames}]`;

    let meta;
    try {
      meta = capture(shot, o.scroll);
    } catch (err) {
      stats.errors += 1;
      const hint = CODE_HINT[err.code] ?? '';
      process.stdout.write(`${tag} 截屏失败 ${err.code}${hint ? ` — ${hint}` : ''}${err.size ? ` (${err.size})` : ''}\n`);
      return false;
    }

    if (meta.scrollSkipped) {
      process.stdout.write(`${tag} ⚠ 请求了滚动但微信不在前台，本帧跳过滚动（截图仍然有效）\n`);
    }

    if (!meta.foreground && !coveredWarned) {
      coveredWarned = true;
      process.stdout.write(
        `${tag} ⚠ 微信窗口不在前台：屏幕拷贝可能把挡住它的窗口也截进来。建议把微信切到前台。\n`,
      );
    }

    const hash = frameHash(shot);
    if (hash && hash === lastHash) {
      stats.skipped += 1;
      process.stdout.write(`${tag} 画面未变化，跳过 OCR（累计跳过 ${stats.skipped}）\n`);
      return true;
    }
    lastHash = hash;

    let payload;
    try {
      payload = ocr(shot, json, o.scale, o.invert);
    } catch (err) {
      stats.errors += 1;
      const hint = CODE_HINT[err.code] ?? '';
      process.stdout.write(`${tag} OCR 失败 ${err.code}${hint ? ` — ${hint}` : ''}\n`);
      return false;
    }

    const parsed = parseOcrLines(payload.lines, {
      pageWidth: payload.pageWidth ?? 0,
      baseDate: o.date || '',
    });
    stats.ocrLines += payload.lines?.length ?? 0;
    stats.warnings += parsed.warnings.length;

    const before = readExisting(messagesFile);
    const merged = dedupe([...before, ...parsed.messages]);
    const delta = merged.length - before.length;

    if (delta > 0 || !existsSync(messagesFile)) {
      writeFileSync(messagesFile, toMessagesText(merged), 'utf8');
      stats.added += delta;
    }

    process.stdout.write(
      `${tag} ${meta.width}x${meta.height} fg=${meta.foreground ? 1 : 0} ocrLines=${payload.lines?.length ?? 0} parsed=${parsed.messages.length} +${delta} 累计=${merged.length}\n`,
    );
    return true;
  };

  process.stdout.write(
    [
      `采集目标: ${roomJson.name} (${roomJson.kind}) -> ${roomDir}`,
      `间隔 ${intervalSec}s${maxFrames ? ` / 上限 ${maxFrames} 帧` : ''}；不模拟输入、不读内存；Ctrl+C 结束`,
    ].join('\n') + '\n',
  );

  const finish = (reason) => {
    cleanup();
    process.stdout.write(
      `\n${reason}：帧 ${stats.frames}，跳过 ${stats.skipped}，OCR 行 ${stats.ocrLines}，新增 ${stats.added} 条，` +
        `累计 ${readExisting(messagesFile).length} 条，告警 ${stats.warnings}，错误 ${stats.errors}\n`,
    );
  };

  if (o.once) {
    tick();
    finish('完成');
    return;
  }

  const first = tick();
  if (maxFrames && stats.frames >= maxFrames) {
    finish('到达帧数上限');
    return;
  }

  const timer = setInterval(() => {
    const ok = tick();
    if (maxFrames && stats.frames >= maxFrames) {
      clearInterval(timer);
      finish('到达帧数上限');
    }
    return ok;
  }, intervalSec * 1000);
  if (typeof timer.unref === 'function') timer.unref();

  const stop = () => {
    clearInterval(timer);
    finish('停止');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // 首帧失败时给一句明确指引，避免"什么都没发生"的困惑
  if (!first) {
    process.stdout.write('提示：先把微信主窗口打开到目标群聊（不要最小化、不要被遮挡），再重试。\n');
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err?.code ?? 'ERROR'}: ${err?.message ?? err}\n`);
  process.exit(1);
}
