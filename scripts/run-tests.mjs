#!/usr/bin/env node
/**
 * 测试入口。
 *
 * 为什么不用 `node --test test/`：该写法会为每个测试文件 spawn 一个子进程，
 * 在 DSH 的沙箱里会以 `spawn EPERM` 失败（不是测试本身的问题）。
 * 这里改为在本进程内顺序 import 各测试文件，结果由 node:test 在退出时汇总。
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = join(ROOT, 'test');

const files = (await readdir(TEST_DIR)).filter((file) => file.endsWith('.test.js')).sort();

if (files.length === 0) {
  console.error('没有找到任何测试文件');
  process.exitCode = 1;
} else {
  for (const file of files) {
    await import(pathToFileURL(join(TEST_DIR, file)).href);
  }
}
