#!/usr/bin/env node
/**
 * 文件模式演示：读你手动导出的聊天记录，跑一遍完整链路。
 *
 * 跑法：node scripts/file-demo.mjs <exportRoot>
 * 例：  node scripts/file-demo.mjs samples/export-template
 *
 * 自检不写死哨兵字符串，而是：把被拒绝会话的全部消息收集起来，
 * 断言它们一个字都没进产物——这样换成你自己的数据也能验证。
 */
import { createFileAdapter } from '../src/adapters/file.js';
import { createService } from '../src/service.js';
import { renderDigest } from '../src/summarize.js';

const SECRET = 'demo-secret-0123456789';
const exportRoot = process.argv[2];

if (!exportRoot) {
  console.error('用法：node scripts/file-demo.mjs <exportRoot>');
  process.exit(1);
}

const adapter = createFileAdapter({ exportRoot });

let allRooms;
try {
  allRooms = await adapter.listRooms();
} catch (err) {
  console.error(`读取导出目录失败：${err.code ?? 'UNKNOWN'} — ${err.message}`);
  process.exit(1);
}

console.log(`== 导出目录 ${exportRoot} ==`);
console.log(`  发现 ${allRooms.length} 个会话目录`);

if (allRooms.length === 0) {
  console.log('  本次没有可摘要的数据（目录里没有任何带 room.json 的会话）');
  console.log('  这是正常结果，不是失败：没有导出就没有输入。');
  process.exit(0);
}

const service = createService({ adapter, secret: SECRET });

const rooms = await service.listRooms();
console.log('\n== 可读会话 ==');
if (rooms.allowed.length === 0) console.log('  （无）');
for (const room of rooms.allowed) console.log(`  允许  ${room.roomHandle}  [${room.kind}] ${room.name ?? ''}`);
for (const item of rooms.denied) console.log(`  拒绝  ${item.auditRef ?? '(无句柄)'}  ${item.reason}`);

const result = await service.runSummary({ trigger: 'manual' });
console.log(`\n== 运行结果 == status=${result.status}  summarized=${result.summarized.length}  denied=${result.denied.length}`);
if (result.status !== 'COMPLETED') {
  console.error(`  失败：${result.code ?? result.reason}`);
  process.exit(1);
}

for (const entry of service.store.all()) {
  console.log(`\n== 摘要 ${entry.roomHandle}（seq ${entry.provenance.seqFrom}–${entry.provenance.seqTo}）==`);
  console.log(renderDigest(entry.digest));
}

// 通用负向检查：被拒会话的任何一条文本，都不得出现在产物里。
const allowedRawIds = new Set();
for (const room of allRooms) {
  const decision = rooms.allowed.some((item) => item.name === room.name && item.kind === room.authoritativeKind);
  if (!decision) allowedRawIds.add(room.rawId);
}

const deniedTexts = [];
for (const rawId of allowedRawIds) {
  const room = allRooms.find((item) => item.rawId === rawId);
  const messages = await adapter.fetchMessages({ room, fromSeq: 0 });
  for (const message of messages) deniedTexts.push(message.text);
}

const produced = JSON.stringify(service.store.all());
const leaked = deniedTexts.filter((text) => produced.includes(text));

console.log('\n== 自检 ==');
console.log(`  被拒会话条数：${deniedTexts.length}`);
console.log(`  负向检查（被拒内容零出现）：${leaked.length === 0 ? 'PASS' : `FAIL（泄露 ${leaked.length} 条）`}`);

const producedSomething = service.store.all().length > 0;
if (producedSomething) {
  console.log('  阳性对照（至少产出一份摘要）：PASS');
} else {
  // 没有任何可读会话时，阳性对照无从谈起——不能算失败，也不能算通过
  console.log('  阳性对照：SKIP（本次没有可摘要的群，既不算通过也不算失败）');
}

if (leaked.length > 0) process.exitCode = 1;
