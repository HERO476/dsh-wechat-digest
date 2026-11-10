import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileStore } from '../src/store-file.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HANDLE = '0123456789abcdef';
const OTHER = 'fedcba9876543210';

async function tmp() {
  return mkdtemp(join(ROOT, '.tmp-store-'));
}

test('摘要落盘后，新实例能读回（重启不丢）', async () => {
  const dir = await tmp();
  try {
    const first = createFileStore({ dir });
    first.bindAllowed([HANDLE]);
    first.put({
      roomHandle: HANDLE,
      digest: { tasks: ['写周报'], activities: [], mentions: [] },
      provenance: { seqFrom: 1, seqTo: 9 },
      trigger: 'manual',
      createdAt: '2026-11-10T00:00:00Z',
    });

    // 模拟进程重启：新建实例读同一个目录
    const second = createFileStore({ dir });
    const entries = second.all();
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].digest.tasks, ['写周报']);
    assert.equal(entries[0].provenance.seqTo, 9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('磁盘上绝不出现聊天原文（多余字段被丢弃）', async () => {
  const dir = await tmp();
  try {
    const store = createFileStore({ dir });
    store.bindAllowed([HANDLE]);
    store.put({
      roomHandle: HANDLE,
      digest: { tasks: ['x'] },
      provenance: { seqFrom: 1, seqTo: 2 },
      trigger: 'manual',
      // 故意塞入不该落盘的东西
      messages: [{ text: '这是聊天原文-SECRET-LEAK' }],
      text: '这是聊天原文-SECRET-LEAK',
      rawId: 'ZZZ-RAWID-CANARY@chatroom',
    });

    const onDisk = await readFile(store.path, 'utf8');
    assert.equal(onDisk.includes('SECRET-LEAK'), false, '聊天原文不得落盘');
    assert.equal(onDisk.includes('ZZZ-RAWID-CANARY'), false, '原始会话 id 不得落盘');
    assert.ok(onDisk.includes(HANDLE));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('未放行的句柄被二次拒绝', async () => {
  const dir = await tmp();
  try {
    const store = createFileStore({ dir });
    store.bindAllowed([HANDLE]);
    assert.throws(
      () => store.put({ roomHandle: OTHER, digest: {}, provenance: { seqFrom: 1, seqTo: 2 } }),
      /STORE_SCOPE_DENIED/,
    );
    assert.equal(store.all().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺 provenance 被拒', async () => {
  const dir = await tmp();
  try {
    const store = createFileStore({ dir });
    store.bindAllowed([HANDLE]);
    assert.throws(() => store.put({ roomHandle: HANDLE, digest: {} }), /STORE_PROVENANCE_REQUIRED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('损坏的历史行被跳过并计数，不炸掉启动', async () => {
  const dir = await tmp();
  try {
    const store = createFileStore({ dir });
    store.bindAllowed([HANDLE]);
    store.put({ roomHandle: HANDLE, digest: {}, provenance: { seqFrom: 1, seqTo: 2 } });

    const fs = await import('node:fs/promises');
    await fs.appendFile(store.path, '{这不是合法 JSON}\n{"没有必需字段":true}\n', 'utf8');

    const reloaded = createFileStore({ dir });
    assert.equal(reloaded.all().length, 1, '合法行应保留');
    assert.equal(reloaded.skippedLines, 2, '两行坏数据应被计数');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺目录参数直接拒绝', () => {
  assert.throws(() => createFileStore({}), /STORE_DIR_REQUIRED/);
});
