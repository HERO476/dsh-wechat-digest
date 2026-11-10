/**
 * 跨进程运行锁：两个进程（设置页 / MCP 子进程）共用一个数据目录时只允许一个在跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileLock, LOCK_FILE_NAME } from '../src/run-lock.js';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-digest-lock-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('同一时刻只能有一个持锁者', async () => {
  await withDir(async (dir) => {
    const a = createFileLock({ dir });
    const b = createFileLock({ dir });

    const first = a.tryAcquire('manual');
    assert.equal(first.ok, true);
    assert.match(first.jobId, /^job-/);

    const second = b.tryAcquire('scheduled');
    assert.equal(second.ok, false, '另一个实例必须被挡下');
    assert.equal(second.jobId, first.jobId, '应报告正在跑的那个 job');

    assert.equal(a.release(), first.jobId);
    assert.equal(b.tryAcquire('scheduled').ok, true, '释放后可以再抢');
  });
});

test('锁文件里记录 pid 与触发方式（可审计）', async () => {
  await withDir(async (dir) => {
    const lock = createFileLock({ dir });
    lock.tryAcquire('manual');
    const owner = JSON.parse(await readFile(join(dir, LOCK_FILE_NAME), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.trigger, 'manual');
    assert.match(owner.jobId, /^job-/);
    lock.release();
  });
});

test('陈旧锁（上次进程被杀）可以被接管', async () => {
  await withDir(async (dir) => {
    const path = join(dir, LOCK_FILE_NAME);
    await writeFile(path, `${JSON.stringify({ jobId: 'job-dead', pid: 999999, trigger: 'manual' })}\n`, 'utf8');

    // 把 mtime 拨到 10 分钟前，模拟崩溃残留
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(path, old, old);

    const lock = createFileLock({ dir, staleMs: 60_000 });
    assert.equal(lock.tryAcquire('manual').ok, true, '超过 staleMs 的锁应被清掉');
  });
});

test('未过期的锁不会被抢（避免把正在跑的任务打断）', async () => {
  await withDir(async (dir) => {
    const path = join(dir, LOCK_FILE_NAME);
    await writeFile(path, `${JSON.stringify({ jobId: 'job-live', pid: 1, trigger: 'manual' })}\n`, 'utf8');

    const lock = createFileLock({ dir, staleMs: 60 * 60 * 1000 });
    const got = lock.tryAcquire('manual');
    assert.equal(got.ok, false);
    assert.equal(got.jobId, 'job-live');
  });
});

test('不是持有者就不能删掉别人的锁', async () => {
  await withDir(async (dir) => {
    const a = createFileLock({ dir });
    a.tryAcquire('manual');
    const b = createFileLock({ dir });
    assert.equal(b.release(), null, '没有持有锁的实例 release 应当无副作用');
    // a 仍然持锁
    assert.equal(createFileLock({ dir }).tryAcquire('manual').ok, false);
    a.release();
  });
});
