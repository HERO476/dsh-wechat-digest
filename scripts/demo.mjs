#!/usr/bin/env node
/**
 * 端到端演示：用假数据源跑完整条链路，不碰微信。
 *
 * 跑法：node scripts/demo.mjs
 */
import { createFixtureAdapter, DEFAULT_FIXTURE, GROUP_SENTINEL, PRIVATE_SENTINEL } from '../src/adapters/fixture.js';
import { createService } from '../src/service.js';
import { renderDigest } from '../src/summarize.js';
import { createToolHandlers } from '../src/tools.js';

const SECRET = 'demo-secret-0123456789';

const service = createService({
  adapter: createFixtureAdapter(DEFAULT_FIXTURE),
  secret: SECRET,
});
const tools = createToolHandlers(service);

const rooms = await tools.list_rooms();
console.log('== 可读会话 ==');
for (const room of rooms.allowed) console.log(`  允许  ${room.roomHandle}  [${room.kind}] ${room.name ?? ''}`);
for (const item of rooms.denied) console.log(`  拒绝  ${item.auditRef ?? '(无句柄)'}  ${item.reason}`);

const result = await tools.run_summary();
console.log('\n== 运行结果 ==');
console.log(`  status=${result.status}  summarized=${result.summarized?.length ?? 0}  skipped=${result.skipped?.length ?? 0}  denied=${result.denied?.length ?? 0}`);
if (result.status !== 'COMPLETED') {
  console.error(`  失败：${result.code ?? result.reason}`);
  process.exitCode = 1;
}

for (const entry of service.store.all()) {
  console.log(`\n== 摘要 ${entry.roomHandle}（seq ${entry.provenance.seqFrom}–${entry.provenance.seqTo}，触发=${entry.trigger}）==`);
  console.log(renderDigest(entry.digest));
}

// 两道自检：阳性对照必须命中，私聊哨兵必须零出现。
const everything = JSON.stringify(service.store.all());
const positiveOk = everything.includes(GROUP_SENTINEL);
const negativeOk = !everything.includes(PRIVATE_SENTINEL);

console.log('\n== 自检 ==');
console.log(`  阳性对照（群哨兵必须出现）：${positiveOk ? 'PASS' : 'FAIL'}`);
console.log(`  负向检查（私聊哨兵必须为零）：${negativeOk ? 'PASS' : 'FAIL'}`);

if (!positiveOk || !negativeOk) process.exitCode = 1;
