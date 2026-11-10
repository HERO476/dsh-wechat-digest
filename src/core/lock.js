/**
 * 互斥锁：同一时刻只允许一次运行。
 * 第二次触发直接返回已有 jobId，不排队、不重复读库。
 */
export function createMemoryLock() {
  let held = null;
  let counter = 0;

  return {
    tryAcquire(trigger) {
      if (held) return { ok: false, jobId: held.jobId };
      held = { jobId: `job-${++counter}`, trigger, startedAt: Date.now() };
      return { ok: true, jobId: held.jobId };
    },
    release() {
      const jobId = held?.jobId ?? null;
      held = null;
      return jobId;
    },
    get currentJobId() {
      return held?.jobId ?? null;
    },
  };
}
