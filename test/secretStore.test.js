/**
 * 句柄密钥来源：不再有仓库里的默认常量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSecret, clearSecretCache, secretPath, MIN_SECRET_LENGTH } from '../src/secret-store.js';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-digest-secret-'));
  clearSecretCache();
  try {
    return await fn(dir);
  } finally {
    clearSecretCache();
    await rm(dir, { recursive: true, force: true });
  }
}

test('环境变量优先，且不会去创建文件', async () => {
  await withDir(async (dir) => {
    const value = 'x'.repeat(MIN_SECRET_LENGTH + 4);
    const resolved = resolveSecret({ env: { WECHAT_DIGEST_SECRET: value }, dataDir: dir });
    assert.equal(resolved.secret, value);
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.path, null);
  });
});

test('环境变量太短直接拒绝（不静默降级到默认值）', async () => {
  await withDir(async (dir) => {
    assert.throws(() => resolveSecret({ env: { WECHAT_DIGEST_SECRET: 'short' }, dataDir: dir }), /SECRET_TOO_SHORT/);
  });
});

test('没有环境变量时首次生成并落盘，第二次读到同一个值', async () => {
  await withDir(async (dir) => {
    const first = resolveSecret({ env: {}, dataDir: dir });
    assert.equal(first.source, 'generated');
    assert.equal(first.secret.length, 64, '32 字节随机值的 hex');

    clearSecretCache();
    const second = resolveSecret({ env: {}, dataDir: dir });
    assert.equal(second.source, 'file');
    assert.equal(second.secret, first.secret, '重启后句柄必须稳定');

    const onDisk = (await readFile(secretPath(dir), 'utf8')).trim();
    assert.equal(onDisk, first.secret);
  });
});

test('两次独立的首次解析会得到同一个值（wx 创建语义）', async () => {
  await withDir(async (dir) => {
    const a = resolveSecret({ env: {}, dataDir: dir });
    clearSecretCache();
    const b = resolveSecret({ env: {}, dataDir: dir });
    assert.equal(a.secret, b.secret);
  });
});

test('密钥不再是仓库里的公开常量', async () => {
  await withDir(async (dir) => {
    const { secret } = resolveSecret({ env: {}, dataDir: dir });
    assert.notEqual(secret, 'local-dev-secret-0123456789');
    assert.ok(secret.length >= MIN_SECRET_LENGTH);
  });
});

test('密钥文件损坏 → 明确报错（而不是悄悄换一把新密钥）', async () => {
  await withDir(async (dir) => {
    await writeFile(secretPath(dir), 'short\n', 'utf8');
    assert.throws(() => resolveSecret({ env: {}, dataDir: dir }), /SECRET_FILE_CORRUPT/);
  });
});

test('落盘文件权限尽量收紧（POSIX 下为 0600）', { skip: process.platform === 'win32' }, async () => {
  await withDir(async (dir) => {
    resolveSecret({ env: {}, dataDir: dir });
    const mode = (await stat(secretPath(dir))).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});
