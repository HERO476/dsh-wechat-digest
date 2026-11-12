#!/usr/bin/env node
/**
 * 把「聊天截图」变成插件能读的导出数据。
 *
 * 为什么不直连微信：微信 4.x 库是 SQLCipher 加密，第三方解密工具已被官方要求下架；
 * 读进程内存会拖累账号安全。所以这里只做「你截图 → 识别 → 入库」。
 *
 * 用法：
 *   node scripts/import-screenshot.mjs shot.png --room 产品评审群
 *   node scripts/import-screenshot.mjs a.png b.png --room 产品评审群 --append
 *   node scripts/import-screenshot.mjs shot.png --room 某人 --kind private --date 2026-11-12
 *
 * 输出：<exportRoot>/<slug>/room.json + messages.txt
 * 副作用：只写 exports/；不碰微信进程、不联网、不打印聊天内容。
 */

import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importScreenshot } from '../src/screenshot-import.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function usage(code = 0) {
  const msg = [
    '用法: node scripts/import-screenshot.mjs <图片...> --room <会话名> [options]',
    '',
    '  --room    会话名（写进 room.json 的 name，可中文）',
    '  --slug    目录名（只用字母数字下划线；不给则按名字生成稳定哈希）',
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

function main() {
  const { images, opts } = parseArgs(process.argv.slice(2));
  if (images.length === 0) usage(2);
  if (!opts.room) usage(2);
  if (opts.kind !== 'group' && opts.kind !== 'private') {
    process.stderr.write('--kind 只能是 group 或 private\n');
    process.exit(2);
  }

  const exportDir = opts.out ?? process.env.WECHAT_DIGEST_EXPORT_DIR ?? `${ROOT}/exports`;

  const results = [];
  for (const image of images) {
    results.push(
      importScreenshot({
        imagePath: resolve(image),
        room: opts.room,
        kind: opts.kind,
        slug: opts.slug,
        date: opts.date,
        exportDir,
        scale: opts.scale,
        invert: opts.invert,
        append: opts.append || results.length > 0,
      }),
    );
  }

  const last = results[results.length - 1];
  // 只报计数与路径，不打印聊天内容
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        room: last.room,
        kind: last.kind,
        dir: last.dir,
        images: results.length,
        ocrLines: results.reduce((sum, r) => sum + r.ocrLines, 0),
        messages: last.messages,
        appended: opts.append,
        warnings: last.warnings.slice(0, 5),
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
