import test from 'node:test';
import assert from 'node:assert/strict';

import { createFixtureAdapter, DEFAULT_FIXTURE, GROUP_SENTINEL, PRIVATE_SENTINEL } from '../src/adapters/fixture.js';
import { createService } from '../src/service.js';
import { createToolHandlers } from '../src/tools.js';
import { defaultPolicy } from '../src/core/policy.js';
import { renderDigest } from '../src/summarize.js';

const SECRET = 'demo-secret-0123456789';
const GROUP = '12345678@chatroom';

function build({ policy } = {}) {
  const service = createService({
    adapter: createFixtureAdapter(DEFAULT_FIXTURE),
    secret: SECRET,
    ...(policy ? { policy } : {}),
  });
  return { service, tools: createToolHandlers(service) };
}

test('端到端：假数据跑通，群被摘要，私聊与公众号被拒', async () => {
  const { service, tools } = build();

  const rooms = await tools.list_rooms();
  assert.equal(rooms.allowed.length, 1, '默认策略下只有群可读');
  assert.equal(rooms.allowed[0].kind, 'group');
  assert.equal(rooms.denied.length, 2);

  const result = await tools.run_summary();
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.summarized.length, 1);
  assert.equal(service.store.all().length, 1);

  const digest = renderDigest(service.store.all()[0].digest);
  assert.ok(digest.includes('任务'), '摘要里应有任务段');
  assert.ok(digest.includes(GROUP_SENTINEL), '阳性对照：群哨兵必须出现');
  assert.equal(digest.includes(PRIVATE_SENTINEL), false, '私聊哨兵必须零出现');
});

test('整份产物里私聊哨兵为零（不只摘要正文）', async () => {
  const { service, tools } = build();
  const result = await tools.run_summary();
  const everything = JSON.stringify({ result, store: service.store.all() });
  assert.equal(everything.includes(PRIVATE_SENTINEL), false);
  assert.ok(everything.includes(GROUP_SENTINEL));
});

test('列表里不出现任何原始会话 id', async () => {
  const { tools } = build();
  const rooms = await tools.list_rooms();
  const serialized = JSON.stringify(rooms);
  for (const rawId of Object.keys(DEFAULT_FIXTURE.messagesByRoom)) {
    assert.equal(serialized.includes(rawId), false, `泄露了原始 id: ${rawId}`);
  }
});

test('打开私聊开关后，私聊出现在可读列表并可被摘要', async () => {
  const policy = defaultPolicy();
  policy.private.defaultEnabled = true;
  const { service, tools } = build({ policy });

  const rooms = await tools.list_rooms();
  assert.equal(rooms.allowed.length, 2);

  await tools.run_summary();
  const everything = JSON.stringify(service.store.all());
  assert.ok(everything.includes(PRIVATE_SENTINEL), '开关打开后私聊应为可读（证明开关不是死开关）');
});

test('关掉某个群后它不再出现在可读列表', async () => {
  const policy = defaultPolicy();
  policy.group.overrides = { [GROUP]: { enabled: false } };
  const { tools } = build({ policy });

  const rooms = await tools.list_rooms();
  assert.equal(rooms.allowed.length, 0);
  assert.ok(rooms.denied.some((item) => item.reason === 'GROUP_DISABLED'));
});

test('策略损坏 → 全关，一个都读不到', async () => {
  const { service, tools } = build({ policy: { version: 1, group: { defaultEnabled: 'yes' } } });
  assert.equal(service.policyError !== null, true);
  const rooms = await tools.list_rooms();
  assert.equal(rooms.allowed.length, 0);
  const result = await tools.run_summary();
  assert.equal(result.summarized.length, 0);
});

test('按句柄取摘要；非法句柄被拒', async () => {
  const { service, tools } = build();
  await tools.run_summary();
  const handle = service.store.all()[0].roomHandle;

  const ok = await tools.get_summary({ roomHandle: handle });
  assert.equal(ok.status, 'OK');
  assert.equal(ok.entries.length, 1);

  const bad = await tools.get_summary({ roomHandle: 'not-a-handle' });
  assert.equal(bad.status, 'REJECTED');

  const missing = await tools.get_summary({ roomHandle: '0123456789abcdef' });
  assert.equal(missing.status, 'NOT_FOUND');
});

test('工具层拒绝多余参数（不会忽略未知键继续跑）', async () => {
  const { tools } = build();
  await assert.rejects(() => tools.run_summary({ scope: 'wxid_abc' }), /UNEXPECTED_PARAM/);
  await assert.rejects(() => tools.list_rooms({ scope: 'all' }), /UNEXPECTED_PARAM/);
});

test('工具面里没有发送类方法', () => {
  const { tools } = build();
  for (const name of Object.keys(tools)) {
    assert.equal(/send|reply|post|forward/i.test(name), false, name);
  }
});

test('服务构造要求 secret 足够长', () => {
  assert.throws(() => createService({ adapter: createFixtureAdapter(), secret: 'short' }), /SERVICE_SECRET_TOO_SHORT/);
  assert.throws(() => createService({ secret: SECRET }), /SERVICE_MISSING_ADAPTER/);
});
