/**
 * 模型注册表：摘要可选的 provider 与模型。
 *
 * 目录来源（权威）：DSH profile 的 `llm-pi-ai.config.providers` 与 DeepSeek 官方 API。
 * 这里把它内联成一份可测试的注册表，并允许用 `<dataDir>/models.json` 覆盖/追加，
 * 这样以后加模型不必改代码。
 *
 * 重要区分：**能在 DSH 里选** ≠ **本插件能直接调用**。
 * 插件是独立进程，只能用「OpenAI 兼容 HTTP + API Key」的方式调用；
 * 账号登录态（OAuth）没有可用的 API Key，因此标记为不可调用，而不是假装能跑。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** provider 默认表。 */
export const DEFAULT_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'deepseek-official',
    label: 'DeepSeek（官方 API）',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    callable: true,
    models: Object.freeze([
      Object.freeze({ id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' }),
      Object.freeze({ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }),
    ]),
  }),
  Object.freeze({
    id: 'commandcode',
    label: 'Command Code (GOAT)',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    apiKeyEnv: 'COMMAND_CODE_API_KEY',
    callable: true,
    models: Object.freeze([
      Object.freeze({ id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash (latest)' }),
    ]),
  }),
  Object.freeze({
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    callable: true,
    headers: Object.freeze({ 'x-opencode-session': 'dsh-wechat-digest', 'User-Agent': 'deepseek-harness/0.2.1' }),
    models: Object.freeze([
      Object.freeze({ id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' }),
      Object.freeze({ id: 'glm-5.3-flash', label: 'GLM 5.3 Flash' }),
      Object.freeze({ id: 'glm-5.3', label: 'GLM 5.3' }),
      Object.freeze({ id: 'glm-5.2', label: 'GLM 5.2' }),
      Object.freeze({ id: 'kimi-k3', label: 'Kimi K3' }),
      Object.freeze({ id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' }),
      Object.freeze({ id: 'mimo-v2.6-flash', label: 'MiMo V2.6 Flash' }),
      Object.freeze({ id: 'mimo-v2.6-pro', label: 'MiMo V2.6 Pro' }),
      Object.freeze({ id: 'mimo-v2.5', label: 'MiMo V2.5' }),
      Object.freeze({ id: 'minimax-m3.1-flash', label: 'MiniMax M3.1 Flash' }),
      Object.freeze({ id: 'hy4-preview', label: 'HY4 Preview' }),
      Object.freeze({ id: 'hy3', label: 'HY3' }),
      Object.freeze({ id: 'step-5-preview', label: 'Step 5 Preview' }),
    ]),
  }),
  Object.freeze({
    id: 'deepseek-account',
    label: 'DeepSeek 账号（已登录）',
    baseUrl: null,
    apiKeyEnv: null,
    callable: false,
    reason: '这是账号登录态（OAuth），没有 OpenAI 兼容的 API Key，插件作为独立进程无法直接调用',
    models: Object.freeze([
      Object.freeze({ id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' }),
      Object.freeze({ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }),
    ]),
  }),
]);

export function defaultCatalog() {
  return { providers: DEFAULT_PROVIDERS.map((provider) => ({ ...provider, models: provider.models.map((m) => ({ ...m })) })) };
}

export function findProvider(catalog, providerId) {
  return (catalog?.providers ?? []).find((provider) => provider.id === providerId) ?? null;
}

export function findModel(catalog, providerId, modelId) {
  const provider = findProvider(catalog, providerId);
  if (!provider) return null;
  const model = (provider.models ?? []).find((item) => item.id === modelId);
  return model ? { provider, model } : null;
}

/** 第一个可调用的 provider + 它的第一个模型。 */
export function firstCallable(catalog) {
  for (const provider of catalog?.providers ?? []) {
    if (provider.callable && provider.models?.length) {
      return { providerId: provider.id, modelId: provider.models[0].id };
    }
  }
  return { providerId: 'deepseek-official', modelId: 'deepseek-flash' };
}

export function catalogPath(dataDir) {
  return join(dataDir, 'models.json');
}

/**
 * 读注册表：默认表 + models.json 覆盖（按 provider id 合并，models 数组整体替换）。
 * 文件损坏时退回默认表，并报告错误——不因为一个可选文件把摘要整体打死。
 */
export function loadCatalog(dataDir) {
  const fallback = defaultCatalog();
  if (!dataDir) return { catalog: fallback, error: null, path: null };

  const path = catalogPath(dataDir);
  if (!existsSync(path)) return { catalog: fallback, error: null, path };

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { catalog: fallback, error: `PARSE:${err.message}`, path };
  }

  if (!raw || !Array.isArray(raw.providers)) {
    return { catalog: fallback, error: 'BAD_SHAPE', path };
  }

  const byId = new Map(fallback.providers.map((provider) => [provider.id, provider]));
  for (const incoming of raw.providers) {
    if (!incoming || typeof incoming.id !== 'string') continue;
    const base = byId.get(incoming.id) ?? {};
    const models = Array.isArray(incoming.models)
      ? incoming.models
          .filter((model) => model && typeof model.id === 'string')
          .map((model) => ({ id: model.id, label: String(model.label ?? model.id) }))
      : base.models ?? [];

    byId.set(incoming.id, {
      ...base,
      ...incoming,
      models,
      callable: incoming.callable ?? base.callable ?? false,
    });
  }

  return { catalog: { providers: [...byId.values()] }, error: null, path };
}
