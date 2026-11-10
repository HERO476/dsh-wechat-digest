#!/usr/bin/env node
/**
 * core 层纯净性 + 零写能力静态检查。
 *
 * core/ 是纯逻辑层，因此：
 *  - 不得触网、不得起子进程、不得写文件；
 *  - 不得出现任何能驱动微信发送或进程注入的符号；
 *  - 唯一允许引入的 node 内置模块是 node:crypto，且只允许 gate.js 使用。
 *
 * 用法：node scripts/check-core-purity.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CORE_DIR = join(ROOT, 'src', 'core');

const FORBIDDEN_TOKENS = [
  'SendTextMsg',
  'mouse_event',
  'keybd_event',
  'SetCursorPos',
  'SendInput',
  'WriteProcessMemory',
  'CreateRemoteThread',
  'VirtualAllocEx',
  'child_process',
  'execSync',
  'spawnSync',
  'http://',
  'https://',
  'ws://',
];

const ALLOWED_BUILTINS = new Set(['node:crypto']);
const CRYPTO_OWNER = 'gate.js';
const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;

export async function checkCorePurity(coreDir = DEFAULT_CORE_DIR) {
  const violations = [];
  const files = (await readdir(coreDir)).filter((file) => file.endsWith('.js'));

  for (const file of files) {
    const full = join(coreDir, file);
    const source = await readFile(full, 'utf8');
    const where = relative(ROOT, full).split('\\').join('/');

    for (const token of FORBIDDEN_TOKENS) {
      if (source.includes(token)) violations.push(`${where}: 出现禁用符号 ${token}`);
    }

    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec.startsWith('.')) continue;
      if (!spec.startsWith('node:')) {
        violations.push([where, `引入外部依赖 ${spec}`].join(': '));
        continue;
      }
      if (!ALLOWED_BUILTINS.has(spec)) {
        violations.push([where, `引入非允许内置模块 ${spec}`].join(': '));
      }
      if (spec === 'node:crypto' && file !== CRYPTO_OWNER) {
        violations.push([where, `只有 ${CRYPTO_OWNER} 可以使用 node:crypto`].join(': '));
      }
    }
  }

  return { ok: violations.length === 0, violations, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await checkCorePurity();
  if (!result.ok) {
    console.error(result.violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`core 纯净性检查通过（${result.files.length} 个文件）`);
  }
}
