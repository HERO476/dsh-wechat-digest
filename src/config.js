/**
 * 插件配置：群聊选择、私聊开关、定时参数、摘要器。
 *
 * 存在 ~/.dsh/wechat-digest/config.json，由设置页编辑。
 * 校验失败 → 全关（fail-closed），绝不回退到"默认允许"。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalize } from './core/canonical.js';
import { failClosedPolicy } from './core/policy.js';

export const CONFIG_VERSION = 1;
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const TOP_KEYS = new Set(['version', 'groups', 'groupsEnabled', 'private', 'summarizer', 'schedule', 'llm']);
const GROUP_KEYS = new Set(['enabled', 'name']);
const PRIVATE_KEYS = new Set(['enabled', 'chats']);
const SCHEDULE_KEYS = new Set(['enabled', 'kind', 'weekdays', 'time', 'timeZone']);
const LLM_KEYS = new Set(['provider', 'model']);

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    // 群聊总开关：关掉 = 一个群都不读（优先于单群勾选）
    groupsEnabled: true,
    groups: {},
    // 私聊：总开关默认关；chats 是单会话白名单，同样受总开关约束
    private: { enabled: false, chats: {} },
    summarizer: 'llm',
    llm: { provider: 'deepseek-official', model: 'deepseek-flash' },
    schedule: {
      enabled: true,
      kind: 'weekly',
      weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'],
      time: '09:00',
      timeZone: 'Asia/Shanghai',
    },
  };
}

function bad(reason) {
  return { ok: false, reason };
}

export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('NOT_OBJECT');

  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) return bad(`UNKNOWN_KEY:${key}`);
  }
  if (raw.version !== CONFIG_VERSION) return bad(`BAD_VERSION:${String(raw.version)}`);

  // groups：键是会话 id，值显式声明开或关
  // Object.create(null)：防止 "__proto__" 这类键改写本地对象原型（静默丢配置）。
  const groups = Object.create(null);
  const rawGroups = raw.groups ?? {};
  if (rawGroups === null || typeof rawGroups !== 'object' || Array.isArray(rawGroups)) {
    return bad('GROUPS_NOT_OBJECT');
  }
  for (const [id, value] of Object.entries(rawGroups)) {
    const canon = canonicalize(id);
    if (!canon.ok) return bad(`GROUP_BAD_ID:${canon.reason}`);
    // 只接受真正的会话：未分类/被排除的 id 写进来只会变成静默死配置。
    if (canon.kind === 'unknown' || canon.kind === 'excluded') return bad(`GROUP_BAD_KIND:${canon.kind}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('GROUP_NOT_OBJECT');
    for (const key of Object.keys(value)) {
      if (!GROUP_KEYS.has(key)) return bad(`GROUP_UNKNOWN_KEY:${key}`);
    }
    if (typeof value.enabled !== 'boolean') return bad('GROUP_ENABLED_NOT_BOOLEAN');
    if (value.name !== undefined && typeof value.name !== 'string') return bad('GROUP_NAME_NOT_STRING');
    groups[canon.canonicalId] = {
      enabled: value.enabled,
      ...(value.name === undefined ? {} : { name: value.name.slice(0, 120) }),
    };
  }

  // groupsEnabled：群聊总开关（缺省视为开，兼容旧配置）
  const groupsEnabled = raw.groupsEnabled ?? true;
  if (typeof groupsEnabled !== 'boolean') return bad('GROUPS_ENABLED_NOT_BOOLEAN');

  // private：总开关 + 单会话白名单
  const rawPrivate = raw.private ?? { enabled: false };
  if (rawPrivate === null || typeof rawPrivate !== 'object' || Array.isArray(rawPrivate)) {
    return bad('PRIVATE_NOT_OBJECT');
  }
  for (const key of Object.keys(rawPrivate)) {
    if (!PRIVATE_KEYS.has(key)) return bad(`PRIVATE_UNKNOWN_KEY:${key}`);
  }
  if (typeof rawPrivate.enabled !== 'boolean') return bad('PRIVATE_ENABLED_NOT_BOOLEAN');

  const chats = Object.create(null);
  const rawChats = rawPrivate.chats ?? {};
  if (rawChats === null || typeof rawChats !== 'object' || Array.isArray(rawChats)) {
    return bad('PRIVATE_CHATS_NOT_OBJECT');
  }
  for (const [id, value] of Object.entries(rawChats)) {
    const canon = canonicalize(id);
    if (!canon.ok) return bad(`PRIVATE_CHAT_BAD_ID:${canon.reason}`);
    if (canon.kind === 'unknown' || canon.kind === 'excluded') return bad(`PRIVATE_CHAT_BAD_KIND:${canon.kind}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('PRIVATE_CHAT_NOT_OBJECT');
    for (const key of Object.keys(value)) {
      if (!GROUP_KEYS.has(key)) return bad(`PRIVATE_CHAT_UNKNOWN_KEY:${key}`);
    }
    if (typeof value.enabled !== 'boolean') return bad('PRIVATE_CHAT_ENABLED_NOT_BOOLEAN');
    if (value.name !== undefined && typeof value.name !== 'string') return bad('PRIVATE_CHAT_NAME_NOT_STRING');
    chats[canon.canonicalId] = {
      enabled: value.enabled,
      ...(value.name === undefined ? {} : { name: value.name.slice(0, 120) }),
    };
  }

  if (raw.summarizer !== 'llm' && raw.summarizer !== 'heuristic') return bad('SUMMARIZER_INVALID');

  // llm：选中的 provider + model（存在性由设置层按注册表校验）
  const rawLlm = raw.llm ?? defaultConfig().llm;
  if (rawLlm === null || typeof rawLlm !== 'object' || Array.isArray(rawLlm)) return bad('LLM_NOT_OBJECT');
  for (const key of Object.keys(rawLlm)) {
    if (!LLM_KEYS.has(key)) return bad(`LLM_UNKNOWN_KEY:${key}`);
  }
  for (const key of ['provider', 'model']) {
    const value = rawLlm[key];
    if (typeof value !== 'string' || value.trim().length === 0) return bad(`LLM_${key.toUpperCase()}_INVALID`);
    if (value.length > 200) return bad(`LLM_${key.toUpperCase()}_TOO_LONG`);
  }

  // schedule
  const rawSchedule = raw.schedule ?? defaultConfig().schedule;
  if (rawSchedule === null || typeof rawSchedule !== 'object' || Array.isArray(rawSchedule)) {
    return bad('SCHEDULE_NOT_OBJECT');
  }
  for (const key of Object.keys(rawSchedule)) {
    if (!SCHEDULE_KEYS.has(key)) return bad(`SCHEDULE_UNKNOWN_KEY:${key}`);
  }
  if (typeof rawSchedule.enabled !== 'boolean') return bad('SCHEDULE_ENABLED_NOT_BOOLEAN');
  if (rawSchedule.kind !== 'daily' && rawSchedule.kind !== 'weekly') return bad('SCHEDULE_KIND_INVALID');
  if (!TIME_RE.test(String(rawSchedule.time))) return bad('SCHEDULE_TIME_INVALID');

  const weekdays = rawSchedule.weekdays ?? WEEKDAYS.slice(0, 5);
  if (!Array.isArray(weekdays) || weekdays.length === 0) return bad('SCHEDULE_WEEKDAYS_EMPTY');
  for (const day of weekdays) {
    if (!WEEKDAYS.includes(day)) return bad(`SCHEDULE_WEEKDAY_INVALID:${day}`);
  }
  if (typeof rawSchedule.timeZone !== 'string' || rawSchedule.timeZone.length === 0) {
    return bad('SCHEDULE_TIMEZONE_INVALID');
  }

  return {
    ok: true,
    config: {
      version: CONFIG_VERSION,
      groupsEnabled,
      groups,
      private: { enabled: rawPrivate.enabled, chats },
      summarizer: raw.summarizer,
      llm: { provider: rawLlm.provider.trim(), model: rawLlm.model.trim() },
      schedule: {
        enabled: rawSchedule.enabled,
        kind: rawSchedule.kind,
        weekdays: [...weekdays],
        time: String(rawSchedule.time),
        timeZone: rawSchedule.timeZone,
      },
    },
  };
}

/**
 * 配置 → core 的策略对象（gate 直接吃这个）。
 *
 * 总开关优先：总开关关掉时，单会话勾选一律无效（清空 overrides + 默认关），
 * 这样"关掉读取"不会因为某条遗留勾选而漏读。
 */
export function toPolicy(config) {
  const groupsOn = config.groupsEnabled !== false;
  const groupOverrides = {};
  if (groupsOn) {
    for (const [id, value] of Object.entries(config.groups ?? {})) {
      groupOverrides[id] = { enabled: value.enabled };
    }
  }

  // 私聊是**白名单语义**：总开关只是闸门，真正放行靠逐个勾选。
  // 所以 defaultEnabled 恒为 false——没勾的私聊一律不读，即使总开关是开的。
  const privateOn = config.private?.enabled === true;
  const privateOverrides = {};
  if (privateOn) {
    for (const [id, value] of Object.entries(config.private?.chats ?? {})) {
      privateOverrides[id] = { enabled: value.enabled };
    }
  }

  return {
    version: 1,
    group: { defaultEnabled: groupsOn, overrides: groupOverrides },
    private: { defaultEnabled: false, overrides: privateOn ? privateOverrides : {} },
  };
}

export function configPath(dataDir) {
  return join(dataDir, 'config.json');
}

/**
 * 读配置。
 *  - 文件不存在 → 默认配置（正常首次启动）
 *  - 文件损坏   → config 退回空设置，且 policy 为 **fail-closed（全关）**
 *
 * policy 一并返回，避免调用方忘记处理 error 而按"群默认开"放行。
 *
 * @returns {{config:object, error:string|null, policy:object}}
 */
export function loadConfig(path) {
  if (!existsSync(path)) {
    const config = defaultConfig();
    return { config, error: null, policy: toPolicy(config) };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const config = { ...defaultConfig(), groups: {}, private: { enabled: false } };
    return { config, error: `PARSE:${err.message}`, policy: failClosedPolicy(`PARSE:${err.message}`) };
  }

  const parsed = parseConfig(raw);
  if (!parsed.ok) {
    const config = { ...defaultConfig(), groups: {}, private: { enabled: false } };
    return { config, error: parsed.reason, policy: failClosedPolicy(parsed.reason) };
  }

  return { config: parsed.config, error: null, policy: toPolicy(parsed.config) };
}

export function saveConfig(path, config) {
  const parsed = parseConfig(config);
  if (!parsed.ok) {
    const err = new Error(parsed.reason);
    err.code = 'CONFIG_INVALID';
    throw err;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed.config, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return parsed.config;
}
