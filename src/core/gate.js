/**
 * 可见性闸门：全系统唯一的裁决点。
 *
 * 纯函数：无 I/O、无状态、无框架依赖。
 * 放行时返回不透明句柄 roomHandle（HMAC 前 16 位），原始 chat id 到此为止不再向下传。
 * 拒绝时只暴露 auditRef（同一个哈希），便于审计留痕而不写原始 id。
 */

import { createHmac } from 'node:crypto';
import { canonicalize, KIND } from './canonical.js';
import { resolveSwitch } from './policy.js';

export const VERDICT = Object.freeze({ ALLOW: 'ALLOW', DENY: 'DENY' });

export const REASON = Object.freeze({
  INVALID_ID: 'INVALID_ID',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  EXCLUDED_CHANNEL: 'EXCLUDED_CHANNEL',
  UNKNOWN_CHANNEL: 'UNKNOWN_CHANNEL',
  GROUP_DISABLED: 'GROUP_DISABLED',
  PRIVATE_DISABLED: 'PRIVATE_DISABLED',
});

export function roomHandle(secret, canonicalId) {
  return createHmac('sha256', secret).update(`room:${canonicalId}`).digest('hex').slice(0, 16);
}

export function createGate({ secret }) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('GATE_SECRET_TOO_SHORT');
  }

  return function decide({ policy, rawId, authoritativeKind }) {
    const canon = canonicalize(rawId);
    if (!canon.ok) {
      return Object.freeze({
        verdict: VERDICT.DENY,
        reason: REASON.INVALID_ID,
        detail: canon.reason,
        auditRef: null,
      });
    }

    const { canonicalId, kind } = canon;
    const auditRef = roomHandle(secret, canonicalId);

    // 交叉校验：声明形态必须与存储层给出的权威类型一致，不一致即拒。
    if (authoritativeKind !== undefined && authoritativeKind !== null && authoritativeKind !== kind) {
      return deny(auditRef, REASON.TYPE_MISMATCH, `${kind} != ${authoritativeKind}`);
    }

    if (kind === KIND.EXCLUDED) return deny(auditRef, REASON.EXCLUDED_CHANNEL, 'excluded channel');
    if (kind === KIND.UNKNOWN) return deny(auditRef, REASON.UNKNOWN_CHANNEL, 'unclassified id');

    const sw = resolveSwitch(policy, kind, canonicalId);
    if (!sw.enabled) {
      return deny(auditRef, kind === KIND.GROUP ? REASON.GROUP_DISABLED : REASON.PRIVATE_DISABLED, sw.source);
    }

    return Object.freeze({
      verdict: VERDICT.ALLOW,
      kind,
      canonicalId,
      roomHandle: auditRef,
      auditRef,
    });
  };
}

function deny(auditRef, reason, detail) {
  return Object.freeze({ verdict: VERDICT.DENY, reason, detail: detail ?? null, auditRef });
}
