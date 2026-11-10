import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWeChatAdapter, ADAPTER_ERROR } from '../src/adapters/wechat.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function makeTree(accounts) {
  const dir = await mkdtemp(join(ROOT, '.tmp-preflight-'));
  for (const account of accounts) {
    await mkdir(join(dir, account, 'db_storage', 'message'), { recursive: true });
    // 写入非 SQLite 魔数的头部，模拟加密库
    await writeFile(join(dir, account, 'db_storage', 'message', 'message_0.db'), Buffer.from('ec28ac5c8e1b2344', 'hex'));
  }
  return dir;
}

test('数据根不存在 → DATA_ROOT_MISSING', async () => {
  const adapter = createWeChatAdapter({ dataRoot: join(ROOT, 'definitely-missing') });
  await assert.rejects(() => adapter.preflight(), (err) => err.code === ADAPTER_ERROR.DATA_ROOT_MISSING);
});

test('未指定 dataRoot → DATA_ROOT_MISSING', async () => {
  const adapter = createWeChatAdapter({});
  await assert.rejects(() => adapter.preflight(), (err) => err.code === ADAPTER_ERROR.DATA_ROOT_MISSING);
});

test('多个账号但未绑定 → ACCOUNT_AMBIGUOUS（不猜）', async () => {
  const dir = await makeTree(['wxid_aaa111', 'wxid_bbb222']);
  try {
    const adapter = createWeChatAdapter({ dataRoot: dir });
    await assert.rejects(() => adapter.preflight(), (err) => err.code === ADAPTER_ERROR.ACCOUNT_AMBIGUOUS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('绑定指定账号后体检通过，并识别出库是加密的', async () => {
  const dir = await makeTree(['wxid_aaa111', 'wxid_bbb222']);
  try {
    const adapter = createWeChatAdapter({ dataRoot: dir, account: 'wxid_bbb222' });
    const report = await adapter.preflight();
    assert.equal(report.boundAccount, 'wxid_bbb222');
    assert.equal(report.accounts.length, 2);
    assert.equal(report.looksEncrypted, true);
    assert.equal(report.canDecrypt, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('绑定不存在的账号 → ACCOUNT_NOT_FOUND', async () => {
  const dir = await makeTree(['wxid_aaa111']);
  try {
    const adapter = createWeChatAdapter({ dataRoot: dir, account: 'wxid_nope' });
    await assert.rejects(() => adapter.preflight(), (err) => err.code === ADAPTER_ERROR.ACCOUNT_NOT_FOUND);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('未接入密钥能力时取数显式失败，绝不静默降级', async () => {
  const adapter = createWeChatAdapter({ dataRoot: ROOT });
  await assert.rejects(() => adapter.listRooms(), (err) => err.code === ADAPTER_ERROR.DECRYPT_UNAVAILABLE);
  await assert.rejects(() => adapter.fetchMessages({ room: {}, fromSeq: 0 }), (err) => err.code === ADAPTER_ERROR.KEY_PROVIDER_MISSING);
});

test('注入 keyProvider 也不冒充已实现', async () => {
  const adapter = createWeChatAdapter({ dataRoot: ROOT, keyProvider: () => 'fake-key' });
  await assert.rejects(() => adapter.fetchMessages({ room: {}, fromSeq: 0 }), (err) => err.code === ADAPTER_ERROR.DECRYPT_UNAVAILABLE);
});
