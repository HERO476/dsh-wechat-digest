import test from 'node:test';
import assert from 'node:assert/strict';

import { createGate, VERDICT, REASON } from '../src/core/gate.js';
import { defaultPolicy, failClosedPolicy } from '../src/core/policy.js';

const gate = createGate({ secret: 'test-secret-0123456789' });

test('群聊默认放行，并给出不透明句柄', () => {
  const decision = gate({ policy: defaultPolicy(), rawId: '12345678@chatroom' });
  assert.equal(decision.verdict, VERDICT.ALLOW);
  assert.equal(decision.kind, 'group');
  assert.match(decision.roomHandle, /^[0-9a-f]{16}$/);
});

test('私聊默认拒绝', () => {
  const decision = gate({ policy: defaultPolicy(), rawId: 'wxid_abc123' });
  assert.equal(decision.verdict, VERDICT.DENY);
  assert.equal(decision.reason, REASON.PRIVATE_DISABLED);
});

test('显式打开后私聊放行（证明开关真的生效）', () => {
  const policy = defaultPolicy();
  policy.private.defaultEnabled = true;
  const decision = gate({ policy, rawId: 'wxid_abc123' });
  assert.equal(decision.verdict, VERDICT.ALLOW);
});

test('单会话覆盖可以关掉某个群', () => {
  const policy = defaultPolicy();
  policy.group.overrides = { '12345678@chatroom': { enabled: false } };
  const decision = gate({ policy, rawId: '12345678@chatroom' });
  assert.equal(decision.verdict, VERDICT.DENY);
  assert.equal(decision.reason, REASON.GROUP_DISABLED);
});

test('声明为群但权威类型是私聊 → 类型不一致即拒', () => {
  const decision = gate({
    policy: defaultPolicy(),
    rawId: '12345678@chatroom',
    authoritativeKind: 'private',
  });
  assert.equal(decision.verdict, VERDICT.DENY);
  assert.equal(decision.reason, REASON.TYPE_MISMATCH);
});

test('排除通道永不放行（即便群聊默认开）', () => {
  for (const rawId of ['gh_abcdef', 'filehelper', '123@openim', 'weixin']) {
    const decision = gate({ policy: defaultPolicy(), rawId });
    assert.equal(decision.verdict, VERDICT.DENY, rawId);
    assert.equal(decision.reason, REASON.EXCLUDED_CHANNEL, rawId);
  }
});

test('未知形态 fail-closed', () => {
  const decision = gate({ policy: defaultPolicy(), rawId: '张三' });
  assert.equal(decision.verdict, VERDICT.DENY);
  assert.equal(decision.reason, REASON.UNKNOWN_CHANNEL);
});

test('策略损坏时群聊也不再放行', () => {
  const decision = gate({ policy: failClosedPolicy('boom'), rawId: '12345678@chatroom' });
  assert.equal(decision.verdict, VERDICT.DENY);
  assert.equal(decision.reason, REASON.GROUP_DISABLED);
});

test('畸形 id 拒绝且不产生句柄', () => {
  const decision = gate({ policy: defaultPolicy(), rawId: '' });
  assert.equal(decision.verdict, VERDICT.DENY);
  assert.equal(decision.reason, REASON.INVALID_ID);
  assert.equal(decision.auditRef, null);
});

test('句柄稳定且不可反解出原始 id', () => {
  const a = gate({ policy: defaultPolicy(), rawId: '12345678@chatroom' });
  const b = gate({ policy: defaultPolicy(), rawId: '12345678@CHATROOM' });
  assert.equal(a.roomHandle, b.roomHandle);
  assert.equal(a.roomHandle.includes('chatroom'), false);
  assert.equal(a.roomHandle.includes('12345678'), false);
});

test('不同 secret 得到不同句柄', () => {
  const other = createGate({ secret: 'another-secret-987654321' });
  const a = gate({ policy: defaultPolicy(), rawId: '12345678@chatroom' });
  const b = other({ policy: defaultPolicy(), rawId: '12345678@chatroom' });
  assert.notEqual(a.roomHandle, b.roomHandle);
});

test('secret 过短直接拒绝构造', () => {
  assert.throws(() => createGate({ secret: 'short' }), /GATE_SECRET_TOO_SHORT/);
});
