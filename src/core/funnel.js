/**
 * 单漏斗：定时触发与手动触发汇入同一个函数、同一道闸门。
 *
 * 两条铁律：
 *  1) trigger 只有两个合法取值；
 *  2) 入参除 trigger 外多一个键就拒绝 —— 触发只决定「何时跑」，
 *     永远不携带范围，因此「手动触发」不可能变成绕过策略的旁路。
 */

import { VERDICT } from './gate.js';

export const TRIGGERS = Object.freeze(['scheduled', 'manual']);

const REQUIRED_DEPS = ['gate', 'getPolicy', 'listRooms', 'fetchMessages', 'summarize', 'store', 'watermark', 'lock'];

export function createRunner(deps = {}) {
  for (const name of REQUIRED_DEPS) {
    if (!deps[name]) throw new Error(`RUNNER_MISSING_DEP:${name}`);
  }

  const {
    gate,
    getPolicy,
    listRooms,
    fetchMessages,
    summarize,
    store,
    watermark,
    lock,
    now = () => new Date().toISOString(),
  } = deps;

  return async function runSummary(request = {}) {
    const trigger = request?.trigger;
    if (!TRIGGERS.includes(trigger)) {
      return { status: 'REJECTED', reason: 'INVALID_TRIGGER' };
    }

    const extraKeys = Object.keys(request).filter((key) => key !== 'trigger');
    if (extraKeys.length > 0) {
      return { status: 'REJECTED', reason: 'SCOPE_PARAM_FORBIDDEN', keys: extraKeys };
    }

    const lease = lock.tryAcquire(trigger);
    if (!lease.ok) return { status: 'ALREADY_RUNNING', jobId: lease.jobId };

    const jobId = lease.jobId;
    const denied = [];
    const summarized = [];
    const skipped = [];

    try {
      const policy = getPolicy();
      const rooms = await listRooms();
      const allowed = [];

      for (const room of rooms) {
        const decision = gate({
          policy,
          rawId: room.rawId,
          authoritativeKind: room.authoritativeKind,
        });

        if (decision.verdict === VERDICT.ALLOW) {
          allowed.push({
            canonicalId: decision.canonicalId,
            roomHandle: decision.roomHandle,
            room,
          });
        } else {
          denied.push({ auditRef: decision.auditRef, reason: decision.reason, detail: decision.detail ?? null });
        }
      }

      // 存储层二次拒绝的允许集：只有本次放行的句柄才写得进去。
      store.bindAllowed(allowed.map((item) => item.roomHandle));

      for (const item of allowed) {
        const fromSeq = watermark.get(item.canonicalId);
        const messages = await fetchMessages({
          room: item.room,
          canonicalId: item.canonicalId,
          fromSeq,
        });

        if (!Array.isArray(messages) || messages.length === 0) {
          skipped.push({ roomHandle: item.roomHandle, reason: 'NO_NEW_CONTENT' });
          continue;
        }

        const seqFrom = messages[0].seq;
        const seqTo = messages[messages.length - 1].seq;

        const digest = await summarize({ roomHandle: item.roomHandle, messages });

        store.put({
          roomHandle: item.roomHandle,
          digest,
          provenance: { seqFrom, seqTo },
          trigger,
          createdAt: now(),
        });

        watermark.set(item.canonicalId, seqTo);
        summarized.push({ roomHandle: item.roomHandle, seqFrom, seqTo });
      }

      return {
        status: 'COMPLETED',
        jobId,
        trigger,
        summarized,
        skipped,
        denied,
      };
    } catch (err) {
      return {
        status: 'FAILED',
        jobId,
        trigger,
        code: err?.code ?? 'INTERNAL_ERROR',
        message: String(err?.message ?? err),
      };
    } finally {
      store.bindAllowed([]);
      lock.release();
    }
  };
}
