/**
 * 两个写者（设置页宿主进程 / MCP 子进程）之间的可见性与撤销语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStore } from '../src/store-file.js';
import { createService } from '../src/service.js';
import { createFixtureAdapter, DEFAULT_FIXTURE, GROUP_SENTINEL } from '../src/adapters/fixture.js';
import { roomHandle } from '../src/core/gate.js';

const SECRET = 'unit-test-secret-0123456789';
const GROUP_ID = '12345678@chatroom';

function record(handle) {
  return {
    roomHandle: handle,
    digest: { highlights: ['x'], todos: [] },
    provenance: { seqFrom: 1, seqTo: 4 },
    trigger: 'manual',
    createdAt: new Date().toISOString(),
  };
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-digest-store-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('另一个进程写入的摘要，本进程的 store 立刻能读到（不再持有过期快照）', async () => {
  await withDir(async (dir) => {
    const writer = createFileStore({ dir });
    const reader = createFileStore({ dir }); // 先建，模拟另一个进程更早启动

    const handle = roomHandle(SECRET, GROUP_ID);
    assert.equal(reader.all().length, 0);

    writer.bindAllowed([handle]);
    writer.put(record(handle));

    const seen = reader.all();
    assert.equal(seen.length, 1, 'reader 必须重新对齐磁盘，而不是用启动时的缓存');
    assert.equal(seen[0].roomHandle, handle);
  });
});

test('撤销勾选后，历史摘要读不出来（读路径复核策略）', async () => {
  const adapter = createFixtureAdapter(DEFAULT_FIXTURE);
  const handle = roomHandle(SECRET, GROUP_ID);

  let policy = {
    version: 1,
    group: { defaultEnabled: true, overrides: {} },
    private: { defaultEnabled: false, overrides: {} },
  };

  const service = createService({
    adapter,
    secret: SECRET,
    getPolicy: () => policy,
    summarize: async () => ({ highlights: [GROUP_SENTINEL], todos: [] }),
  });

  const run = await service.runSummary({ trigger: 'manual' });
  assert.equal(run.status, 'COMPLETED');
  assert.ok(run.summarized.some((item) => item.roomHandle === handle));

  const before = await service.getSummary(handle);
  assert.equal(before.status, 'OK');

  // 关掉群聊总开关 = 撤销
  policy = { ...policy, group: { defaultEnabled: false, overrides: {} } };
  const after = await service.getSummary(handle);
  assert.equal(after.status, 'DENIED');
  assert.equal(after.reason, 'NOT_VISIBLE_NOW');
});

test('非法句柄仍然被拒，未知句柄仍然是 NOT_FOUND', async () => {
  const service = createService({
    adapter: createFixtureAdapter(DEFAULT_FIXTURE),
    secret: SECRET,
    policy: { version: 1, group: { defaultEnabled: true, overrides: {} }, private: { defaultEnabled: false, overrides: {} } },
    summarize: async () => ({ highlights: [], todos: [] }),
  });

  assert.equal((await service.getSummary('not-a-handle')).status, 'REJECTED');
  assert.equal((await service.getSummary('0123456789abcdef')).status, 'NOT_FOUND');
});

test('设置页与 MCP 用同一把文件锁：并发触发只跑一个', async () => {
  await withDir(async (dir) => {
    const { createFileLock } = await import('../src/run-lock.js');
    const adapter = createFixtureAdapter(DEFAULT_FIXTURE);
    const policy = {
      version: 1,
      group: { defaultEnabled: true, overrides: {} },
      private: { defaultEnabled: false, overrides: {} },
    };

    let summarizeCalls = 0;
    const serviceA = createService({
      adapter,
      secret: SECRET,
      policy,
      lock: createFileLock({ dir }),
      summarize: async () => {
        summarizeCalls += 1;
        return { highlights: ['a'], todos: [] };
      },
    });
    const serviceB = createService({
      adapter,
      secret: SECRET,
      policy,
      lock: createFileLock({ dir }),
      summarize: async () => {
        summarizeCalls += 1;
        return { highlights: ['b'], todos: [] };
      },
    });

    const [first, second] = await Promise.all([
      serviceA.runSummary({ trigger: 'manual' }),
      serviceB.runSummary({ trigger: 'scheduled' }),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, ['ALREADY_RUNNING', 'COMPLETED'], '跨进程锁必须让第二个触发被挡下');
    assert.equal(summarizeCalls, 1, '只应跑一次，不重复计费');
  });
});
