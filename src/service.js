/**
 * 服务层：把适配器、策略、闸门、单漏斗、存储装配起来，对外只暴露三个动作。
 *
 * 对外接口刻意很小：
 *   listRooms()            列出策略允许的会话（只给不透明句柄，不给原始 id）
 *   runSummary({trigger})  跑一次总结
 *   getSummary(roomHandle) 按句柄读摘要
 *
 * 注意：这里没有、也不会有任何"发送"方法。
 */

import { createGate } from './core/gate.js';
import { defaultPolicy, parsePolicy, failClosedPolicy } from './core/policy.js';
import { createRunner } from './core/funnel.js';
import { createGuardStore } from './core/store.js';
import { createMemoryWatermark } from './core/watermark.js';
import { createMemoryLock } from './core/lock.js';
import { summarizeMessages } from './summarize.js';

/**
 * @param {{
 *   adapter: {listRooms:Function, fetchMessages:Function},
 *   secret: string,
 *   policy?: object,
 *   summarize?: Function,
 * }} options
 */
export function createService(options = {}) {
  const {
    adapter,
    secret,
    policy: rawPolicy,
    summarize = summarizeMessages,
    store: injectedStore,
    lock: injectedLock,
    getPolicy: externalPolicyProvider,
  } = options;

  if (!adapter) throw new Error('SERVICE_MISSING_ADAPTER');
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('SERVICE_SECRET_TOO_SHORT');

  // 策略解析失败 → 全关。不是回退默认值。
  const parsed = rawPolicy === undefined ? { ok: true, policy: defaultPolicy() } : parsePolicy(rawPolicy);
  let currentPolicy = parsed.ok ? parsed.policy : failClosedPolicy(parsed.reason);
  let policyError = parsed.ok ? null : parsed.reason;

  /**
   * 每次运行都重新取策略：这样设置页改完配置，下一次调用立刻生效（无需重启）。
   * 提供方返回的应当已经是解析好的策略对象；抛错则 fail-closed。
   */
  function resolvePolicy() {
    if (typeof externalPolicyProvider !== 'function') return currentPolicy;
    try {
      const next = externalPolicyProvider();
      if (!next || typeof next !== 'object') throw new Error('POLICY_PROVIDER_BAD_RETURN');
      currentPolicy = next;
      policyError = null;
      return currentPolicy;
    } catch (err) {
      currentPolicy = failClosedPolicy(String(err?.message ?? err));
      policyError = currentPolicy.degradedReason;
      return currentPolicy;
    }
  }

  const gate = createGate({ secret });
  const store = injectedStore ?? createGuardStore();
  // 默认进程内锁；跨进程场景（设置页 + MCP）由调用方注入文件锁。
  const lock = injectedLock ?? createMemoryLock();

  // 文件模式是"全量快照"，每次都读完整一份，因此不用增量水位线；
  // 否则第二次跑会把整份导出当成"已经摘要过"而全部跳过。
  const baseWatermark = createMemoryWatermark();
  const watermark = adapter.stateless
    ? { get: () => 0, set: () => {}, keys: () => [] }
    : baseWatermark;

  const runner = createRunner({
    gate,
    getPolicy: resolvePolicy,
    listRooms: () => adapter.listRooms(),
    fetchMessages: ({ room, fromSeq }) => adapter.fetchMessages({ room, fromSeq }),
    summarize: ({ messages }) => summarize({ messages }),
    store,
    watermark,
    lock,
  });

  async function listRooms() {
    const rooms = await adapter.listRooms();
    const policy = resolvePolicy();
    const allowed = [];
    const denied = [];

    for (const room of rooms) {
      const decision = gate({ policy, rawId: room.rawId, authoritativeKind: room.authoritativeKind });
      if (decision.verdict === 'ALLOW') {
        allowed.push({ roomHandle: decision.roomHandle, kind: decision.kind, name: room.name ?? null });
      } else {
        denied.push({ auditRef: decision.auditRef, reason: decision.reason });
      }
    }

    return { allowed, denied };
  }

  /**
   * 读摘要：除了格式校验，还要**按当前策略复核**。
   * 否则「取消勾选某个群」之后，历史摘要仍然能被拿到句柄的人无限期读出来。
   */
  async function getSummary(roomHandleValue) {
    if (typeof roomHandleValue !== 'string' || !/^[0-9a-f]{16}$/.test(roomHandleValue)) {
      return { status: 'REJECTED', reason: 'INVALID_HANDLE' };
    }

    const entries = store.all().filter((entry) => entry.roomHandle === roomHandleValue);
    if (entries.length === 0) return { status: 'NOT_FOUND' };

    let stillVisible = false;
    try {
      const policy = resolvePolicy();
      const rooms = await adapter.listRooms();
      stillVisible = rooms.some((room) => {
        const decision = gate({
          policy,
          rawId: room.rawId,
          authoritativeKind: room.authoritativeKind,
        });
        return decision.verdict === 'ALLOW' && decision.roomHandle === roomHandleValue;
      });
    } catch {
      // 读不到策略或导出目录 → 视为不可见（fail-closed）
      stillVisible = false;
    }

    if (!stillVisible) return { status: 'DENIED', reason: 'NOT_VISIBLE_NOW' };
    return { status: 'OK', entries };
  }

  return {
    adapterName: adapter.name ?? 'unknown',
    listRooms,
    runSummary: runner,
    getSummary,
    get policy() {
      return currentPolicy;
    },
    get policyError() {
      return policyError;
    },
    store,
  };
}
