#!/usr/bin/env node
/**
 * 只读体检：看一眼本机微信环境长什么样，不做任何解密、不读任何聊天正文。
 *
 * 跑法：node scripts/preflight.mjs [dataRoot]
 * 默认按本机实测位置探测（注意本机数据在 D 盘，不在 C 盘默认路径）。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { createWeChatAdapter } from '../src/adapters/wechat.js';

/**
 * 候选路径全部在**运行时**由当前用户推导，源码里不出现任何用户名。
 * 数据目录与系统盘不一致时，用第一个参数显式指定：
 *   node scripts/preflight.mjs "D:/你/的/路径/xwechat_files"
 */
const USER = basename(homedir());
const CANDIDATES = [
  join(homedir(), 'Documents', 'xwechat_files'),
  `D:/Users/${USER}/Documents/xwechat_files`,
  'D:/xwechat_files',
];

/** 没显式指定时，逐个候选探测存在的那一个（本机数据常在 D 盘）。 */
function pickDataRoot(explicit) {
  if (explicit) return explicit;
  for (const candidate of CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 忽略不可读候选 */
    }
  }
  return CANDIDATES[0];
}

const dataRoot = pickDataRoot(process.argv[2]);
const account = process.argv[3];
const adapter = createWeChatAdapter({ dataRoot, account });

try {
  const report = await adapter.preflight();
  console.log('== 只读体检 ==');
  console.log(`  数据根        ${report.dataRoot}`);
  console.log(`  账号数        ${report.accounts.length}`);
  for (const account of report.accounts) console.log(`    - ${account}`);
  console.log(`  本次绑定      ${report.boundAccount}`);
  console.log(`  消息库        ${report.messageDbPath}`);
  console.log(`  消息库大小    ${report.messageDbBytes ?? '未知'}`);
  console.log(`  是否加密      ${report.looksEncrypted === null ? '未知' : report.looksEncrypted ? '是' : '否'}`);
  console.log(`  解密能力      ${report.canDecrypt ? '已注入 keyProvider' : '未接入（这是预期状态）'}`);
  console.log('\n结论：体检只证明"库在哪、是不是加密的"，不证明"能不能解密"。');
  console.log('      取数能力需沙箱外组件 + 你的书面授权，见 docs/PHASE2.md。');
} catch (err) {
  console.error(`体检失败：${err.code ?? 'UNKNOWN'} — ${err.message}`);
  process.exitCode = 1;
}
