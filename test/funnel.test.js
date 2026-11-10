import test from 'node:test';
import assert from 'node:assert/strict';

import { createGate } from '../src/core/gate.js';
import { defaultPolicy } from '../src/core/policy.js';
import { createGuardStore } from '../src/core/store.js';
import { createMemoryWatermark } from '../src/core/watermark.js';
import { createMemoryLock } from '../src/core/lock.js';
import { createRunner } from '../src/core/funnel.js';

const SECRET = 'test-secret-0123456789';

function harness({ rooms, policy = defaultPolicy(), messagesByRoom = {} }) {
  const store = createGuardStore();
  const watermark = createMemoryWatermark();
  const lock = createMemoryLock();
  const summarizePayloads = [];
  const fetchCalls = [];

  const runner = createRunner({
    gate: createGate({ secret: SECRET }),
    getPolicy: () => policy,
    listRooms: async () => rooms,
    fetchMessages: async ({ room, canonicalId, fromSeq }) => {
      fetchCalls.push({ rawId: room.rawId, canonicalId, fromSeq });
      return (messagesByRoom[room.rawId] ?? []).filter((message) => message.seq > fromSeq);
    },
    summarize: async ({ roomHandle, messages }) => {
      summarizePayloads.push(JSON.stringify({ roomHandle, messages }));
      return `摘要:${messages.length}条`;
    },
    store,
    watermark,
    lock,
  });

  return { runner, store, watermark, lock, summarizePayloads, fetchCalls };
}

const GROUP = '12345678@chatroom';
const PRIVATE = 'wxid_abc123';

test('两种触发都能跑通', async () => {
  for (const trigger of ['scheduled', 'manual']) {
    const h = harness({
      rooms: [{ rawId: GROUP, authoritativeKind: 'group' }],
      messagesByRoom: { [GROUP]: [{ seq: 1, text: 'hi' }] },
    });
    const result = await h.runner({ trigger });
    assert.equal(result.status, 'COMPLETED', trigger);
    assert.equal(result.summarized.length, 1);
  }
});

test('触发不合法即拒绝', async () => {
  const h = harness({ rooms: [] });
  assert.equal((await h.runner({ trigger: 'now' })).reason, 'INVALID_TRIGGER');
  assert.equal((await h.runner({})).reason, 'INVALID_TRIGGER');
  assert.equal((await h.runner(undefined)).reason, 'INVALID_TRIGGER');
});

test('手动触发不接受任何范围参数（含私聊 id）', async () => {
  const h = harness({
    rooms: [{ rawId: GROUP, authoritativeKind: 'group' }],
    messagesByRoom: { [GROUP]: [{ seq: 1, text: 'x' }] },
  });
  const result = await h.runner({ trigger: 'manual', scope: PRIVATE });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'SCOPE_PARAM_FORBIDDEN');
  assert.equal(h.store.all().length, 0, '被拒的请求不得产生任何摘要');
});

test('私聊默认不会被取数、不会被摘要', async () => {
  const h = harness({
    rooms: [
      { rawId: GROUP, authoritativeKind: 'group' },
      { rawId: PRIVATE, authoritativeKind: 'private' },
    ],
    messagesByRoom: { [GROUP]: [{ seq: 1, text: 'g' }], [PRIVATE]: [{ seq: 1, text: 'p' }] },
  });
  const result = await h.runner({ trigger: 'scheduled' });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(h.fetchCalls.some((call) => call.rawId === PRIVATE), false, '私聊不得进入取数');
  assert.equal(result.summarized.length, 1);
  assert.equal(
    result.denied.some((item) => item.reason === 'PRIVATE_DISABLED'),
    true,
    '私聊应留下拒绝记录',
  );
});

test('双哨兵：群哨兵命中，私聊哨兵三处零出现', async () => {
  const GRP_SENTINEL = 'GRP-5f2c1a9e';
  const PRIV_SENTINEL = 'PRIV-9b7d3e01';

  const h = harness({
    rooms: [
      { rawId: GROUP, authoritativeKind: 'group' },
      { rawId: PRIVATE, authoritativeKind: 'private' },
    ],
    messagesByRoom: {
      [GROUP]: [{ seq: 1, text: `今天开会对齐 ${GRP_SENTINEL}` }],
      [PRIVATE]: [{ seq: 1, text: `私聊内容 ${PRIV_SENTINEL}` }],
    },
  });

  const result = await h.runner({ trigger: 'manual' });

  const payload = h.summarizePayloads.join('\n');
  assert.ok(payload.includes(GRP_SENTINEL), '阳性对照：群哨兵必须命中，否则负向测试是假阴性');

  const surfaces = [
    ['摘要入模 payload', payload],
    ['存储内容', h.store.dump()],
    ['运行结果', JSON.stringify(result)],
  ];
  for (const [where, text] of surfaces) {
    assert.equal(text.includes(PRIV_SENTINEL), false, `${where} 中出现了私聊哨兵`);
  }
});

test('撞车：并发第二次触发返回 ALREADY_RUNNING 且只产出一份', async () => {
  let releaseFetch;
  const store = createGuardStore();

  const runner = createRunner({
    gate: createGate({ secret: SECRET }),
    getPolicy: () => defaultPolicy(),
    listRooms: async () => [{ rawId: GROUP, authoritativeKind: 'group' }],
    fetchMessages: () =>
      new Promise((resolve) => {
        releaseFetch = () => resolve([{ seq: 1, text: 'x' }]);
      }),
    summarize: async () => '摘要',
    store,
    watermark: createMemoryWatermark(),
    lock: createMemoryLock(),
  });

  const first = runner({ trigger: 'manual' });
  const second = await runner({ trigger: 'scheduled' });

  assert.equal(second.status, 'ALREADY_RUNNING');

  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFetch();

  const done = await first;
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.jobId, second.jobId);
  assert.equal(store.all().length, 1);
});

test('水位线：第二次只摘要新增消息', async () => {
  const messages = [
    { seq: 1, text: 'a' },
    { seq: 2, text: 'b' },
  ];
  const h = harness({
    rooms: [{ rawId: GROUP, authoritativeKind: 'group' }],
    messagesByRoom: { [GROUP]: messages },
  });

  const first = await h.runner({ trigger: 'scheduled' });
  assert.equal(first.status, 'COMPLETED');
  assert.deepEqual(first.summarized[0], { roomHandle: first.summarized[0].roomHandle, seqFrom: 1, seqTo: 2 });

  messages.push({ seq: 3, text: 'c' });
  const second = await h.runner({ trigger: 'scheduled' });
  assert.equal(second.status, 'COMPLETED');
  assert.equal(h.fetchCalls.at(-1).fromSeq, 2, '第二次应从水位线 2 之后开始');
  assert.equal(second.summarized[0].seqFrom, 3);
  assert.equal(h.store.all().length, 2);
});

test('没有新消息时不产出空摘要，只标 NO_NEW_CONTENT', async () => {
  const h = harness({
    rooms: [{ rawId: GROUP, authoritativeKind: 'group' }],
    messagesByRoom: { [GROUP]: [] },
  });
  const result = await h.runner({ trigger: 'scheduled' });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.summarized.length, 0);
  assert.deepEqual(result.skipped.map((item) => item.reason), ['NO_NEW_CONTENT']);
  assert.equal(h.store.all().length, 0, '不得用空摘要冒充「没重点」');
});

test('打开私聊开关后私聊可被摘要（证明开关不是摆设）', async () => {
  const policy = defaultPolicy();
  policy.private.defaultEnabled = true;

  const h = harness({
    policy,
    rooms: [{ rawId: PRIVATE, authoritativeKind: 'private' }],
    messagesByRoom: { [PRIVATE]: [{ seq: 1, text: 'hello' }] },
  });

  const result = await h.runner({ trigger: 'manual' });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(h.store.all().length, 1);
});

test('类型不一致的会话被拒（声明群、权威私聊）', async () => {
  const h = harness({
    rooms: [{ rawId: GROUP, authoritativeKind: 'private' }],
    messagesByRoom: { [GROUP]: [{ seq: 1, text: 'x' }] },
  });
  const result = await h.runner({ trigger: 'scheduled' });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.summarized.length, 0);
  assert.equal(result.denied[0].reason, 'TYPE_MISMATCH');
  assert.equal(h.store.all().length, 0);
});

test('存储层二次拒绝：绕过闸门直写被拒', () => {
  const store = createGuardStore();
  store.bindAllowed(['0123456789abcdef']);

  assert.throws(
    () => store.put({ roomHandle: 'ffffffffffffffff', digest: 'x', provenance: { seqFrom: 1, seqTo: 2 } }),
    /STORE_SCOPE_DENIED/,
  );
  assert.throws(
    () => store.put({ roomHandle: '0123456789abcdef', digest: 'x' }),
    /STORE_PROVENANCE_REQUIRED/,
  );
  assert.equal(store.all().length, 0);
});

test('取数失败时返回明确失败码，不产出空摘要', async () => {
  const store = createGuardStore();
  const runner = createRunner({
    gate: createGate({ secret: SECRET }),
    getPolicy: () => defaultPolicy(),
    listRooms: async () => [{ rawId: GROUP, authoritativeKind: 'group' }],
    fetchMessages: async () => {
      const err = new Error('keystore unavailable');
      err.code = 'KEY_UNAVAILABLE';
      throw err;
    },
    summarize: async () => '摘要',
    store,
    watermark: createMemoryWatermark(),
    lock: createMemoryLock(),
  });

  const result = await runner({ trigger: 'scheduled' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'KEY_UNAVAILABLE');
  assert.equal(store.all().length, 0);
});
