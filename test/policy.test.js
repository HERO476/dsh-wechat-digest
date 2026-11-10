import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultPolicy,
  failClosedPolicy,
  parsePolicy,
  resolveSwitch,
  POLICY_VERSION,
} from '../src/core/policy.js';

test('默认策略：群开、私关', () => {
  const policy = defaultPolicy();
  assert.equal(policy.group.defaultEnabled, true);
  assert.equal(policy.private.defaultEnabled, false);
  assert.equal(parsePolicy(policy).ok, true);
});

test('注入 allowAll / send / allowPrivate 一类字段一律拒绝', () => {
  const base = defaultPolicy();
  const injections = [{ allowAll: true }, { send: { enabled: true } }, { allowPrivate: [] }];
  for (const injection of injections) {
    const result = parsePolicy({ ...base, ...injection });
    assert.equal(result.ok, false, JSON.stringify(injection));
  }
});

test('嵌套层出现未知字段也被拒', () => {
  const policy = defaultPolicy();
  policy.private.overrides = { wxid_abc123: { enabled: true, force: true } };
  assert.equal(parsePolicy(policy).ok, false);
});

test('类型错误被拒', () => {
  const policy = defaultPolicy();
  policy.group.defaultEnabled = 'yes';
  assert.equal(parsePolicy(policy).ok, false);
  assert.equal(parsePolicy(null).ok, false);
  assert.equal(parsePolicy([]).ok, false);
  assert.equal(parsePolicy('{}').ok, false);
});

test('版本不符被拒', () => {
  const policy = { ...defaultPolicy(), version: POLICY_VERSION + 1 };
  assert.equal(parsePolicy(policy).ok, false);
});

test('覆盖键必须是合法会话 id', () => {
  const policy = defaultPolicy();
  policy.group.overrides = { '': { enabled: false } };
  assert.equal(parsePolicy(policy).ok, false);
});

test('策略损坏的兜底是全关，不是退回默认值', () => {
  const policy = failClosedPolicy('boom');
  assert.equal(policy.group.defaultEnabled, false);
  assert.equal(policy.private.defaultEnabled, false);
  assert.equal(policy.degraded, true);
  assert.equal(policy.degradedReason, 'boom');
});

test('单会话覆盖优先于全局默认', () => {
  const policy = defaultPolicy();
  policy.private.overrides = { wxid_abc123: { enabled: true } };
  const parsed = parsePolicy(policy);
  assert.equal(parsed.ok, true);
  assert.deepEqual(resolveSwitch(parsed.policy, 'private', 'wxid_abc123'), {
    enabled: true,
    source: 'override',
  });
  assert.deepEqual(resolveSwitch(parsed.policy, 'private', 'wxid_other'), {
    enabled: false,
    source: 'default',
  });
});
