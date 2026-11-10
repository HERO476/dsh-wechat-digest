/**
 * 跨进程运行锁：设置页（宿主进程）与 MCP 子进程共用一个数据目录，
 * 内存锁管不住另一个进程，因此用 `<dataDir>/run.lock` 做互斥（O_EXCL 创建）。
 *
 * 崩溃残留：锁文件超过 staleMs 视为陈旧，清掉后重试一次。
 */

import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_STALE_MS = 30 * 60 * 1000;
export const LOCK_FILE_NAME = 'run.lock';

function fail(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * @param {{dir:string, fileName?:string, staleMs?:number, now?:() => number}} options
 */
export function createFileLock({ dir, fileName = LOCK_FILE_NAME, staleMs = DEFAULT_STALE_MS, now = () => Date.now() } = {}) {
  if (!dir || typeof dir !== 'string') throw fail('LOCK_DIR_REQUIRED');

  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);

  let token = null;
  let jobId = null;

  function readOwner() {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  function isStale() {
    try {
      return now() - statSync(path).mtimeMs > staleMs;
    } catch {
      return false;
    }
  }

  function clearStale() {
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  return {
    tryAcquire(trigger) {
      if (token) return { ok: false, jobId };

      const mine = {
        jobId: `job-${randomBytes(4).toString('hex')}`,
        trigger,
        pid: process.pid,
        startedAt: new Date(now()).toISOString(),
      };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const fd = openSync(path, 'wx');
          try {
            writeSync(fd, `${JSON.stringify(mine)}\n`);
          } finally {
            closeSync(fd);
          }
          token = mine.jobId;
          jobId = mine.jobId;
          return { ok: true, jobId };
        } catch (err) {
          if (err?.code !== 'EEXIST') throw err;
          const owner = readOwner();
          jobId = owner?.jobId ?? null;
          // 陈旧锁（上次进程被杀）→ 清掉重试一次；否则如实报告正在运行。
          if (isStale() && clearStale()) continue;
          return { ok: false, jobId };
        }
      }

      return { ok: false, jobId };
    },

    release() {
      if (!token) return null;
      const owned = readOwner()?.jobId === token;
      if (owned) {
        try {
          unlinkSync(path);
        } catch {
          /* 已被别人清掉 */
        }
      }
      const released = owned ? token : null;
      token = null;
      jobId = null;
      return released;
    },

    get currentJobId() {
      return token;
    },

    get path() {
      return path;
    },
  };
}
