/**
 * 落盘版摘要存储：重启后仍能读到之前生成的摘要。
 *
 * 三条不可越过的底线：
 *  1) 只写白名单字段——**聊天原文永远不可能落盘**，因为代码里没有那条路；
 *  2) 不写原始会话 id，只有 roomHandle（HMAC）；
 *  3) 仍保留"只接受本次放行句柄"的二次拒绝。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HANDLE_RE = /^[0-9a-f]{16}$/;

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.roomHandle !== 'string' || !HANDLE_RE.test(raw.roomHandle)) return null;

  const p = raw.provenance;
  if (!p || typeof p.seqFrom !== 'number' || typeof p.seqTo !== 'number') return null;

  // 白名单构造：任何多余字段（例如有人塞 messages/text）都会被丢弃
  return Object.freeze({
    roomHandle: raw.roomHandle,
    digest: raw.digest ?? null,
    provenance: Object.freeze({ roomHandle: raw.roomHandle, seqFrom: p.seqFrom, seqTo: p.seqTo }),
    trigger: raw.trigger ?? null,
    createdAt: raw.createdAt ?? null,
  });
}

/**
 * @param {{dir:string, fileName?:string}} options
 */
export function createFileStore({ dir, fileName = 'digests.jsonl' } = {}) {
  if (!dir || typeof dir !== 'string') throw fail('STORE_DIR_REQUIRED');

  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);

  const entries = [];
  let skippedLines = 0;

  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }
      const normalized = normalize(parsed);
      if (normalized) entries.push(normalized);
      else skippedLines += 1;
    }
  }

  let allowed = new Set();

  return {
    path,
    get skippedLines() {
      return skippedLines;
    },
    bindAllowed(handles) {
      allowed = new Set(handles);
    },
    put(record) {
      if (!record || typeof record !== 'object') throw fail('STORE_BAD_RECORD');
      if (!allowed.has(record.roomHandle)) throw fail('STORE_SCOPE_DENIED');

      const stored = normalize(record);
      if (!stored) throw fail('STORE_PROVENANCE_REQUIRED');

      appendFileSync(path, `${JSON.stringify(stored)}\n`, 'utf8');
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
