import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, KIND } from '../src/core/canonical.js';

test('群聊形态被识别为 group', () => {
  assert.equal(canonicalize('12345678@chatroom').kind, KIND.GROUP);
});

test('后缀大小写归一后视为同一会话', () => {
  const upper = canonicalize('12345678@CHATROOM');
  const lower = canonicalize('12345678@chatroom');
  assert.equal(upper.ok, true);
  assert.equal(upper.canonicalId, lower.canonicalId);
  assert.equal(upper.kind, lower.kind);
});

test('前导零不剥除，但 kind 判定一致（不产生两种结论）', () => {
  const a = canonicalize('01234567@chatroom');
  const b = canonicalize('1234567@chatroom');
  assert.notEqual(a.canonicalId, b.canonicalId);
  assert.equal(a.kind, b.kind);
});

test('wxid 与自定义微信号判为私聊', () => {
  assert.equal(canonicalize('wxid_testaccount00001').kind, KIND.PRIVATE);
  assert.equal(canonicalize('zhangsan2024').kind, KIND.PRIVATE);
});

test('公众号 / 系统号 / 企业微信被排除', () => {
  assert.equal(canonicalize('gh_abcdef123456').kind, KIND.EXCLUDED);
  assert.equal(canonicalize('filehelper').kind, KIND.EXCLUDED);
  assert.equal(canonicalize('weixin').kind, KIND.EXCLUDED);
  assert.equal(canonicalize('123@openim').kind, KIND.EXCLUDED);
});

test('畸形输入一律不 ok', () => {
  assert.equal(canonicalize('').ok, false);
  assert.equal(canonicalize('   ').ok, false);
  assert.equal(canonicalize(null).ok, false);
  assert.equal(canonicalize(12345).ok, false);
  assert.equal(canonicalize('a'.repeat(201)).ok, false);
  assert.equal(canonicalize('1234\u200b@chatroom').ok, false);
});
