/**
 * 策略：谁可以被读。
 *
 * 三条硬规矩：
 *  1) 字段白名单。出现任何未知字段 → 整份策略作废（不是忽略）。
 *  2) 名字里带 send/reply/allowall/scope/write 一类词的键，按名字直接拒。
 *     目的是防止「以后又悄悄长出一个开关」。
 *  3) 策略损坏 → 全关（fail-closed），不是回退默认值。
 *     否则「把配置写坏」就成了一条恢复放行的旁路。
 */

import { canonicalize } from './canonical.js';

export const POLICY_VERSION = 1;

const ALLOWED_TOP_KEYS = new Set(['version', 'group', 'private']);
const ALLOWED_SCOPE_KEYS = new Set(['defaultEnabled', 'overrides']);
const ALLOWED_OVERRIDE_KEYS = new Set(['enabled']);

const FORBIDDEN_KEY_HINT =
  /send|reply|post|forward|comment|broadcast|poke|allowall|allowprivate|scope|write|exec|shell/i;

export function defaultPolicy() {
  return {
    version: POLICY_VERSION,
    group: { defaultEnabled: true, overrides: {} },
    private: { defaultEnabled: false, overrides: {} },
  };
}

/** 策略损坏时的兜底：群与私聊全部关闭。 */
export function failClosedPolicy(reason = 'POLICY_INVALID') {
  return {
    version: POLICY_VERSION,
    group: { defaultEnabled: false, overrides: {} },
    private: { defaultEnabled: false, overrides: {} },
    degraded: true,
    degradedReason: reason,
  };
}

/**
 * @param {unknown} raw
 * @returns {{ok:true, policy:object} | {ok:false, reason:string}}
 */
export function parsePolicy(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'NOT_OBJECT' };
  }

  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEY_HINT.test(key)) return { ok: false, reason: `FORBIDDEN_KEY:${key}` };
    if (!ALLOWED_TOP_KEYS.has(key)) return { ok: false, reason: `UNKNOWN_KEY:${key}` };
  }

  if (raw.version !== POLICY_VERSION) return { ok: false, reason: `BAD_VERSION:${String(raw.version)}` };

  const group = parseScope(raw.group, 'GROUP');
  if (!group.ok) return group;

  const priv = parseScope(raw.private, 'PRIVATE');
  if (!priv.ok) return priv;

  return {
    ok: true,
    policy: {
      version: POLICY_VERSION,
      group: group.scope,
      private: priv.scope,
    },
  };
}

function parseScope(rawScope, label) {
  const reject = (reason) => ({ ok: false, reason: `${label}_${reason}` });

  if (rawScope === null || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
    return reject('NOT_OBJECT');
  }

  for (const key of Object.keys(rawScope)) {
    if (FORBIDDEN_KEY_HINT.test(key)) return reject(`FORBIDDEN_KEY:${key}`);
    if (!ALLOWED_SCOPE_KEYS.has(key)) return reject(`UNKNOWN_KEY:${key}`);
  }

  if (typeof rawScope.defaultEnabled !== 'boolean') return reject('DEFAULT_NOT_BOOLEAN');

  const rawOverrides = rawScope.overrides ?? {};
  if (rawOverrides === null || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
    return reject('OVERRIDES_NOT_OBJECT');
  }

  const overrides = {};
  for (const [id, value] of Object.entries(rawOverrides)) {
    const canon = canonicalize(id);
    if (!canon.ok) return reject(`OVERRIDE_BAD_ID:${canon.reason}`);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return reject('OVERRIDE_NOT_OBJECT');
    }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEY_HINT.test(key)) return reject(`OVERRIDE_FORBIDDEN_KEY:${key}`);
      if (!ALLOWED_OVERRIDE_KEYS.has(key)) return reject(`OVERRIDE_UNKNOWN_KEY:${key}`);
    }
    if (typeof value.enabled !== 'boolean') return reject('OVERRIDE_NOT_BOOLEAN');
    overrides[canon.canonicalId] = { enabled: value.enabled };
  }

  return { ok: true, scope: { defaultEnabled: rawScope.defaultEnabled, overrides } };
}

/**
 * 单会话覆盖优先于全局默认。
 * @returns {{enabled:boolean, source:'override'|'default'}}
 */
export function resolveSwitch(policy, kind, canonicalId) {
  const scope = kind === 'group' ? policy.group : policy.private;
  const override = scope?.overrides?.[canonicalId];
  if (override) return { enabled: override.enabled, source: 'override' };
  return { enabled: Boolean(scope?.defaultEnabled), source: 'default' };
}
