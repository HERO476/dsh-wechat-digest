/**
 * 加固用例：专挑"看起来对、其实可能被绕"的地方下手。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate, VERDICT, REASON } from '../src/core/gate.js';
import { defaultPolicy } from '../src/core/policy.js';
import { createFixtureAdapter } from '../src/adapters/fixture.js';
import { createWeChatAdapter } from '../src/adapters/wechat.js';
import { createService } from '../src/service.js';
import { defaultPolicy as policyFactory } from '../src/core/policy.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'demo-secret-0123456789';
const gate = createGate({ secret: SECRET });

// ── 1. 策略覆盖不得打开"排除通道" ────────────────────────────────
test('策略覆盖不能把公众号/企业微信打开（覆盖开关不越权）', () => {
  const policy = defaultPolicy();
  policy.group.overrides = {
    gh_abcdef: { enabled: true },
    '123@openim': { enabled: true },
    filehelper: { enabled: true },
  };

  for (const rawId of ['gh_abcdef', '123@openim', 'filehelper']) {
    const decision = gate({ policy, rawId });
    assert.equal(decision.verdict, VERDICT.DENY, rawId);
    assert.equal(decision.reason, REASON.EXCLUDED_CHANNEL, rawId);
  }
});

test('私聊覆盖只对私聊生效，不能改变群聊默认', () => {
  const policy = defaultPolicy();
  policy.private.overrides = { wxid_abc: { enabled: true } };

  assert.equal(gate({ policy, rawId: 'wxid_abc' }).verdict, VERDICT.ALLOW);
  assert.equal(gate({ policy, rawId: 'wxid_other' }).verdict, VERDICT.DENY);
  // 群聊默认仍然是开的，且不受私聊覆盖影响
  assert.equal(gate({ policy, rawId: '123@chatroom' }).verdict, VERDICT.ALLOW);
});

// ── 2. 摘要失败：不落空摘要、不留死锁 ────────────────────────────
test('摘要抛错 → FAILED、零落盘、且锁已释放（下一次能正常跑）', async () => {
  let shouldFail = true;
  const service = createService({
    adapter: createFixtureAdapter(),
    secret: SECRET,
    summarize: async () => {
      if (shouldFail) {
        const err = new Error('模型 401');
        err.code = 'SUMMARIZE_HTTP_401';
        throw err;
      }
      return { tasks: ['ok'], activities: [], mentions: [], total: 1, seqFrom: 1, seqTo: 1 };
    },
  });

  const failed = await service.runSummary({ trigger: 'manual' });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.code, 'SUMMARIZE_HTTP_401');
  assert.equal(service.store.all().length, 0, '失败时不得落任何摘要');

  shouldFail = false;
  const ok = await service.runSummary({ trigger: 'manual' });
  assert.equal(ok.status, 'COMPLETED', '失败后必须能再跑，锁不能卡死');
  assert.equal(service.store.all().length, 1);
});

// ── 3. 明文库与加密库要能区分（不能一律当加密） ──────────────────
async function makeDataRoot(headerBytes) {
  const dir = await mkdtemp(join(ROOT, '.tmp-magic-'));
  const account = 'wxid_magic';
  await mkdir(join(dir, account, 'db_storage', 'message'), { recursive: true });
  await writeFile(join(dir, account, 'db_storage', 'message', 'message_0.db'), headerBytes);
  return dir;
}

test('明文 SQLite 头被识别为未加密', async () => {
  const dir = await makeDataRoot(Buffer.from('SQLite format 3\u0000rest-of-header', 'latin1'));
  try {
    const report = await createWeChatAdapter({ dataRoot: dir, account: 'wxid_magic' }).preflight();
    assert.equal(report.looksEncrypted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SQLCipher 头被识别为加密', async () => {
  const dir = await makeDataRoot(Buffer.from('ec28ac5c8e1b2344', 'hex'));
  try {
    const report = await createWeChatAdapter({ dataRoot: dir, account: 'wxid_magic' }).preflight();
    assert.equal(report.looksEncrypted, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 4. 结果里不得出现任何原始会话 id ─────────────────────────────
test('run_summary 与 list_rooms 的返回里不含原始会话 id', async () => {
  const policy = policyFactory();
  policy.private.defaultEnabled = true;

  const service = createService({ adapter: createFixtureAdapter(), secret: SECRET, policy });

  const rooms = await service.listRooms();
  const result = await service.runSummary({ trigger: 'manual' });
  const blob = JSON.stringify({ rooms, result, store: service.store.all() });

  for (const rawId of ['12345678@chatroom', 'wxid_demo111111', 'gh_demo123456']) {
    assert.equal(blob.includes(rawId), false, `泄露了原始 id: ${rawId}`);
  }
});

// ── 5. 同一会话的两种写法必须得到同一裁决（归一化只做一次） ──────
test('大小写变体得到同一裁决与同一句柄', () => {
  const policy = defaultPolicy();
  const a = gate({ policy, rawId: '12345678@chatroom' });
  const b = gate({ policy, rawId: '  12345678@CHATROOM  ' });
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.roomHandle, b.roomHandle);
});
