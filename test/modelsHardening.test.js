/**
 * models.json 硬化：一份可写的 models.json 不能变成「把 DSH 全局凭证 + 聊天内容
 * 发往任意地址」的通用外发管道。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadCatalog, catalogPath, findModel } from '../src/models.js';

async function withCatalog(raw, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-digest-models-'));
  try {
    await writeFile(catalogPath(dir), JSON.stringify(raw), 'utf8');
    return await fn(loadCatalog(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('http:// 远端地址被拒绝（只允许 https）', async () => {
  await withCatalog(
    {
      providers: [
        {
          id: 'attacker',
          baseUrl: 'http://evil.example/v1',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          callable: true,
          models: [{ id: 'm' }],
        },
      ],
    },
    ({ catalog, rejected }) => {
      assert.equal(findModel(catalog, 'attacker', 'm'), null, 'http 远端 provider 必须被丢弃');
      assert.ok(rejected.includes('attacker'));
    },
  );
});

test('回环 http（本地模型）仍然允许', async () => {
  await withCatalog(
    {
      providers: [
        { id: 'local', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_KEY', callable: true, models: [{ id: 'q' }] },
      ],
    },
    ({ catalog }) => {
      const found = findModel(catalog, 'local', 'q');
      assert.ok(found);
      assert.equal(found.provider.baseUrl, 'http://127.0.0.1:11434/v1');
    },
  );
});

test('非法的 apiKeyEnv 被拒绝（不能拿任意环境变量名去取凭证）', async () => {
  await withCatalog(
    {
      providers: [
        { id: 'x', baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'not a var; rm -rf', callable: true, models: [{ id: 'm' }] },
      ],
    },
    ({ catalog, rejected }) => {
      assert.equal(findModel(catalog, 'x', 'm'), null);
      assert.ok(rejected.includes('x'));
    },
  );
});

test('headers 白名单：未知头与换行注入被丢弃', async () => {
  await withCatalog(
    {
      providers: [
        {
          id: 'weird',
          baseUrl: 'https://api.example.com/v1',
          apiKeyEnv: 'SOME_KEY',
          callable: true,
          headers: {
            'X-Opencode-Session': 'ok',
            'X-Injected': 'nope',
            'X-CRLF': 'a\r\nB: c',
            'content-type': 'application/json',
          },
          models: [{ id: 'm' }],
        },
      ],
    },
    ({ catalog }) => {
      const found = findModel(catalog, 'weird', 'm');
      assert.ok(found);
      assert.deepEqual(found.provider.headers, { 'x-opencode-session': 'ok', 'content-type': 'application/json' });
    },
  );
});

test('非法 provider id（__proto__ 等）不会污染原型，也不会进入注册表', async () => {
  await withCatalog(
    {
      providers: [
        { id: '__proto__', baseUrl: 'https://api.example.com/v1', callable: true, models: [{ id: 'm' }] },
        { id: 'constructor', baseUrl: 'https://api.example.com/v1', callable: true, models: [{ id: 'm' }] },
      ],
    },
    ({ catalog }) => {
      assert.equal(findModel(catalog, '__proto__', 'm'), null);
      assert.equal(findModel(catalog, 'constructor', 'm'), null);
      assert.equal({}.polluted, undefined);
      assert.ok(Array.isArray(catalog.providers));
    },
  );
});

test('models.json 不能凭空造出 apiKeyEnv 之外的额外字段（白名单构造）', async () => {
  await withCatalog(
    {
      providers: [
        {
          id: 'deepseek-official',
          baseUrl: 'https://mirror.example.com/v1',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          callable: true,
          injectCommand: 'rm -rf /',
          models: [{ id: 'deepseek-flash', label: 'M' }],
        },
      ],
    },
    ({ catalog }) => {
      const provider = catalog.providers.find((item) => item.id === 'deepseek-official');
      assert.equal(provider.injectCommand, undefined, '未知字段必须被丢弃');
      assert.equal(provider.baseUrl, 'https://mirror.example.com/v1');
    },
  );
});

test('没有 models.json 时用默认目录，且不带 rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-digest-models-empty-'));
  try {
    const { catalog, rejected } = loadCatalog(dir);
    assert.ok(catalog.providers.length >= 3);
    assert.deepEqual(rejected, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
