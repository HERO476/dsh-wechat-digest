import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defaultConfig,
  parseConfig,
  toPolicy,
  loadConfig,
  saveConfig,
  configPath,
  CONFIG_VERSION,
} from '../src/config.js';
import { createGate, VERDICT } from '../src/core/gate.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'demo-secret-0123456789';
const gate = createGate({ secret: SECRET });

test('默认配置：群开、私关、定时工作日 09:00', () => {
  const config = defaultConfig();
  assert.equal(config.private.enabled, false);
  assert.equal(config.schedule.time, '09:00');
  assert.deepEqual(config.schedule.weekdays, ['MO', 'TU', 'WE', 'TH', 'FR']);
  assert.equal(parseConfig(config).ok, true);
});

test('未知字段被拒（防止又长出一个开关）', () => {
  const config = { ...defaultConfig(), allowAll: true };
  assert.equal(parseConfig(config).ok, false);
});

test('版本不符被拒', () => {
  assert.equal(parseConfig({ ...defaultConfig(), version: CONFIG_VERSION + 1 }).ok, false);
});

test('非法时间被拒', () => {
  for (const time of ['9:00', '25:00', '09:60', '', 'now']) {
    const config = defaultConfig();
    config.schedule.time = time;
    assert.equal(parseConfig(config).ok, false, time);
  }
});

test('空星期被拒', () => {
  const config = defaultConfig();
  config.schedule.weekdays = [];
  assert.equal(parseConfig(config).ok, false);
});

test('非法星期被拒', () => {
  const config = defaultConfig();
  config.schedule.weekdays = ['MO', 'XX'];
  assert.equal(parseConfig(config).ok, false);
});

test('非法摘要器被拒', () => {
  assert.equal(parseConfig({ ...defaultConfig(), summarizer: 'gpt' }).ok, false);
});

test('群键必须是合法会话 id', () => {
  const config = defaultConfig();
  config.groups = { '': { enabled: false } };
  assert.equal(parseConfig(config).ok, false);
});

test('配置转策略：关掉的群在闸门处生效', () => {
  const config = defaultConfig();
  config.groups = { '12345@chatroom': { enabled: false } };
  const policy = toPolicy(config);

  assert.equal(gate({ policy, rawId: '12345@chatroom' }).verdict, VERDICT.DENY);
  assert.equal(gate({ policy, rawId: '99999@chatroom' }).verdict, VERDICT.ALLOW, '未列出的群仍按默认开');
});

test('配置转策略：私聊是白名单，先开总开关再逐个勾选', () => {
  const off = toPolicy(defaultConfig());
  assert.equal(gate({ policy: off, rawId: 'wxid_abc' }).verdict, VERDICT.DENY);

  // 只开总开关、没勾任何私聊 → 仍然都不读（白名单语义）
  const masterOnly = defaultConfig();
  masterOnly.private.enabled = true;
  assert.equal(gate({ policy: toPolicy(masterOnly), rawId: 'wxid_abc' }).verdict, VERDICT.DENY);

  // 开总开关 + 勾选具体会话 → 只读勾选的那个
  const picked = defaultConfig();
  picked.private.enabled = true;
  picked.private.chats = { wxid_abc: { enabled: true } };
  const policy = toPolicy(picked);
  assert.equal(gate({ policy, rawId: 'wxid_abc' }).verdict, VERDICT.ALLOW);
  assert.equal(gate({ policy, rawId: 'wxid_other' }).verdict, VERDICT.DENY);
});

test('配置文件损坏 → fail-closed（全关），不是回退默认', async () => {
  const dir = await mkdtemp(join(ROOT, '.tmp-config-'));
  try {
    const path = configPath(dir);
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, '{ 这不是 JSON', 'utf8');

    const { config, error, policy } = loadConfig(path);
    assert.ok(error, '应报告错误');
    assert.equal(policy.group.defaultEnabled, false, '损坏时连群默认都必须关掉');
    assert.equal(gate({ policy, rawId: '12345@chatroom' }).verdict, VERDICT.DENY, '损坏时群也必须关掉');
    assert.equal(config.private.enabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置文件不存在 → 用默认配置，不算错误', async () => {
  const dir = await mkdtemp(join(ROOT, '.tmp-config-'));
  try {
    const { config, error } = loadConfig(configPath(dir));
    assert.equal(error, null);
    assert.equal(config.private.enabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('保存后能读回，且写入的是规范化结果', async () => {
  const dir = await mkdtemp(join(ROOT, '.tmp-config-'));
  try {
    const path = configPath(dir);
    const config = defaultConfig();
    config.groups = { '12345@chatroom': { enabled: false, name: '测试群' } };
    config.summarizer = 'heuristic';

    saveConfig(path, config);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.summarizer, 'heuristic');
    assert.equal(raw.groups['12345@chatroom'].enabled, false);

    const reloaded = loadConfig(path);
    assert.equal(reloaded.error, null);
    assert.equal(reloaded.config.summarizer, 'heuristic');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('保存非法配置直接抛错，不写盘', async () => {
  const dir = await mkdtemp(join(ROOT, '.tmp-config-'));
  try {
    const path = configPath(dir);
    assert.throws(() => saveConfig(path, { version: 1, summarizer: 'gpt' }), /CONFIG_INVALID|SUMMARIZER/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 群聊总开关 ───────────────────────────────────────────────
test('群聊总开关关掉 → 一个群都不读（哪怕之前勾选过）', () => {
  const config = defaultConfig();
  config.groups = { '12345@chatroom': { enabled: true } };
  config.groupsEnabled = false;

  const parsed = parseConfig(config);
  assert.equal(parsed.ok, true);

  const policy = toPolicy(parsed.config);
  assert.equal(gate({ policy, rawId: '12345@chatroom' }).verdict, VERDICT.DENY, '勾选过也不能读');
  assert.equal(gate({ policy, rawId: '99999@chatroom' }).verdict, VERDICT.DENY, '未勾选的更不能读');
});

test('群聊总开关默认开（旧配置没有该字段也兼容）', () => {
  const legacy = { version: 1, groups: {}, private: { enabled: false }, summarizer: 'heuristic' };
  const parsed = parseConfig(legacy);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.groupsEnabled, true);
  assert.equal(parsed.config.private.chats && typeof parsed.config.private.chats, 'object');

  const policy = toPolicy(parsed.config);
  assert.equal(gate({ policy, rawId: '12345@chatroom' }).verdict, VERDICT.ALLOW);
});

test('群聊总开关必须是布尔', () => {
  const config = defaultConfig();
  config.groupsEnabled = 'yes';
  assert.equal(parseConfig(config).ok, false);
});

// ── 私聊：总开关 + 单会话白名单 ──────────────────────────────
test('私聊总开关关掉 → 单会话勾选一律无效', () => {
  const config = defaultConfig();
  config.private = { enabled: false, chats: { wxid_abc123: { enabled: true } } };

  const parsed = parseConfig(config);
  assert.equal(parsed.ok, true);

  const policy = toPolicy(parsed.config);
  assert.equal(gate({ policy, rawId: 'wxid_abc123' }).verdict, VERDICT.DENY, '总开关关闭时白名单不生效');
});

test('私聊总开关打开后，只读勾选的私聊', () => {
  const config = defaultConfig();
  config.private = { enabled: true, chats: { wxid_abc123: { enabled: true } } };

  const policy = toPolicy(parseConfig(config).config);
  assert.equal(gate({ policy, rawId: 'wxid_abc123' }).verdict, VERDICT.ALLOW);
  assert.equal(gate({ policy, rawId: 'wxid_other999' }).verdict, VERDICT.DENY, '没勾的不读');
});

test('私聊白名单里显式关掉的会话不读', () => {
  const config = defaultConfig();
  config.private = { enabled: true, chats: { wxid_abc123: { enabled: false } } };

  const policy = toPolicy(parseConfig(config).config);
  assert.equal(gate({ policy, rawId: 'wxid_abc123' }).verdict, VERDICT.DENY);
});

test('私聊白名单里的非法会话 id 被拒', () => {
  const config = defaultConfig();
  config.private = { enabled: true, chats: { '': { enabled: true } } };
  assert.equal(parseConfig(config).ok, false);
});

test('私聊里出现未知字段被拒', () => {
  const config = defaultConfig();
  config.private = { enabled: true, chats: {}, allowAll: true };
  assert.equal(parseConfig(config).ok, false);
});

test('名字必须是字符串，超长截断到 120', () => {
  const badName = defaultConfig();
  badName.groups = { '12345@chatroom': { enabled: true, name: { 不是: '字符串' } } };
  assert.equal(parseConfig(badName).ok, false, '对象名应被拒');

  const badPrivateName = defaultConfig();
  badPrivateName.private = { enabled: true, chats: { wxid_abc: { enabled: true, name: 123 } } };
  assert.equal(parseConfig(badPrivateName).ok, false, '数字名应被拒');

  const long = defaultConfig();
  long.groups = { '12345@chatroom': { enabled: true, name: 'x'.repeat(500) } };
  const parsed = parseConfig(long);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.groups['12345@chatroom'].name.length, 120);
});
