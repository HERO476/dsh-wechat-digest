/**
 * 摘要存储层（内存实现，用于本期纯逻辑验证）。
 *
 * 三层自我保护：
 *  1) 只接受本次运行中被闸门放行的 roomHandle —— 二次拒绝，不依赖调用方自觉；
 *  2) 缺 provenance 一律不写 —— 保证每条要点都能回溯到来源群与消息范围；
 *  3) 只存摘要与溯源定位，永不存聊天原文。
 */

export function createGuardStore() {
  const entries = [];
  let allowed = new Set();

  return {
    bindAllowed(handles) {
      allowed = new Set(handles);
    },
    put(record) {
      if (!record || typeof record !== 'object') throw fail('STORE_BAD_RECORD');
      if (!allowed.has(record.roomHandle)) throw fail('STORE_SCOPE_DENIED');

      const p = record.provenance;
      if (!p || typeof p.seqFrom !== 'number' || typeof p.seqTo !== 'number') {
        throw fail('STORE_PROVENANCE_REQUIRED');
      }

      const stored = Object.freeze({
        roomHandle: record.roomHandle,
        digest: record.digest,
        provenance: Object.freeze({ roomHandle: record.roomHandle, seqFrom: p.seqFrom, seqTo: p.seqTo }),
        trigger: record.trigger,
        createdAt: record.createdAt ?? null,
      });

      entries.push(stored);
      return stored;
    },
    all() {
      return entries.slice();
    },
    dump() {
      return JSON.stringify(entries);
    },
  };
}

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}
