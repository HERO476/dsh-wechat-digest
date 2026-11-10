import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLlmConfig, readCredential } from '../src/llm-config.mjs';
import { defaultCatalog, loadCatalog, findModel } from '../src/models.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function creds(content) {
  const dir = await mkdtemp(join(ROOT, '.tmp-cred-'));
  const path = join(dir, '.credentials.yaml');
  await writeFile(path, content);
  return { dir, path };
}

test('注册表包含用户界面里出现的全部 provider', () => {
  const { providers } = defaultCatalog();
  const ids = providers.map((provider) => provider.id);
  for (const expected of ['deepseek-official', 'deepseek-account', 'commandcode', 'opencode-go']) {
    assert.ok(ids.includes(expected), `缺少 ${expected}`);
  }
});

test('OpenCode Go 的 13 个模型都在注册表里', () => {
  const catalog = defaultCatalog();
  const found = findModel(catalog, 'opencode-go', 'glm-5.3');
  assert.ok(found);
  const provider = catalog.providers.find((item) => item.id === 'opencode-go');
  assert.equal(provider.models.length, 13);
  assert.equal(provider.baseUrl, 'https://opencode.ai/inference/go/openai/v1');
  assert.equal(provider.apiKeyEnv, 'OPENCODE_API_KEY');
});

test('DeepSeek 账号（OAuth）被标记为不可直接调用', () => {
  const resolved = resolveLlmConfig({ providerId: 'deepseek-account', modelId: 'deepseek-flash', env: {}, dataDir: undefined });
  assert.equal(resolved.available, false);
  assert.match(resolved.reason, /账号登录态|OAuth/);
});

test('有同名凭据时可选任意 provider', async () => {
  const { dir, path } = await creds(
    ['refs:', '  OPENCODE_API_KEY: sk-opencode-test', '  COMMAND_CODE_API_KEY: sk-cc-test'].join('\n'),
  );
  try {
    const opencode = resolveLlmConfig({
      providerId: 'opencode-go',
      modelId: 'kimi-k3',
      env: {},
      credentialsPath: path,
    });
    assert.equal(opencode.available, true);
    assert.equal(opencode.apiKey, 'sk-opencode-test');
    assert.equal(opencode.baseUrl, 'https://opencode.ai/inference/go/openai/v1');
    assert.equal(opencode.headers['x-opencode-session'], 'dsh-wechat-digest');

    const commandcode = resolveLlmConfig({
      providerId: 'commandcode',
      modelId: 'deepseek/deepseek-v4.1-flash',
      env: {},
      credentialsPath: path,
    });
    assert.equal(commandcode.available, true);
    assert.equal(commandcode.apiKey, 'sk-cc-test');
    assert.equal(commandcode.baseUrl, 'https://api.commandcode.ai/provider/v1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('环境变量优先于凭据文件，且按 provider 的 apiKeyEnv 取名', async () => {
  const { dir, path } = await creds('refs:\n  OPENCODE_API_KEY: from-file\n');
  try {
    const fromEnv = resolveLlmConfig({
      providerId: 'opencode-go',
      modelId: 'hy3',
      env: { OPENCODE_API_KEY: 'from-env' },
      credentialsPath: path,
    });
    assert.equal(fromEnv.apiKey, 'from-env');
    assert.equal(fromEnv.apiKeySource, 'env');

    const fromFile = resolveLlmConfig({ providerId: 'opencode-go', modelId: 'hy3', env: {}, credentialsPath: path });
    assert.equal(fromFile.apiKey, 'from-file');
    assert.equal(fromFile.apiKeySource, 'credentials');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺密钥时明确报告缺哪个变量', () => {
  const resolved = resolveLlmConfig({
    providerId: 'opencode-go',
    modelId: 'glm-5.2',
    env: {},
    credentialsPath: join(ROOT, 'no-such-credentials.yaml'),
  });
  assert.equal(resolved.available, false);
  assert.match(resolved.reason, /OPENCODE_API_KEY/);
});

test('未知模型给出可读原因，而不是崩', () => {
  const resolved = resolveLlmConfig({ providerId: 'nope', modelId: 'nope', env: {} });
  assert.equal(resolved.available, false);
  assert.match(resolved.reason, /没有这个模型/);
});

test('不给 provider 时回落到第一个可调用的模型', () => {
  const resolved = resolveLlmConfig({ env: { DEEPSEEK_API_KEY: 'sk-x' }, credentialsPath: join(ROOT, 'none.yaml') });
  assert.equal(resolved.providerId, 'deepseek-official');
  assert.ok(resolved.modelId);
});

test('dataDir 下的 models.json 可以追加新 provider', async () => {
  const dir = await mkdtemp(join(ROOT, '.tmp-catalog-'));
  try {
    await writeFile(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'my-local',
            label: '本地 Ollama',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKeyEnv: 'OLLAMA_API_KEY',
            callable: true,
            models: [{ id: 'qwen3', label: 'Qwen3' }],
          },
        ],
      }),
    );

    const { catalog, error } = loadCatalog(dir);
    assert.equal(error, null);
    assert.ok(catalog.providers.some((provider) => provider.id === 'my-local'));
    // 默认 provider 仍在（合并而非替换）
    assert.ok(catalog.providers.some((provider) => provider.id === 'opencode-go'));

    const resolved = resolveLlmConfig({
      providerId: 'my-local',
      modelId: 'qwen3',
      env: { OLLAMA_API_KEY: 'k' },
      dataDir: dir,
    });
    assert.equal(resolved.available, true);
    assert.equal(resolved.baseUrl, 'http://127.0.0.1:11434/v1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('models.json 损坏时退回默认表，不打死摘要', async () => {
  const dir = await mkdtemp(join(ROOT, '.tmp-catalog-'));
  try {
    await writeFile(join(dir, 'models.json'), '{ 不是 JSON', 'utf8');
    const { catalog, error } = loadCatalog(dir);
    assert.ok(error);
    assert.ok(catalog.providers.length >= 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('凭据窄匹配仍然防正则注入', async () => {
  const { dir, path } = await creds('refs:\n  X: y\n');
  try {
    assert.equal(readCredential('A.*B', { credentialsPath: path }), null);
    assert.equal(readCredential('X', { credentialsPath: path }), 'y');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
