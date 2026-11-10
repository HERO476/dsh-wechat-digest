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

const API_KEY_ENV_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const SAFE_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'user-agent',
  'x-opencode-session',
  'x-api-key',
  'anthropic-version',
]);

/**
 * baseUrl 只允许 https；http 仅放行回环地址（本地模型）。
 * 这条是 models.json 覆盖的唯一边界：否则一份可写的 models.json
 * 就能把 DSH 全局凭据 + 群聊内容发到任意地址。
 */
function safeBaseUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.toString().replace(/\/$/, '');
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')) {
    return url.toString().replace(/\/$/, '');
  }
  return null;
}

function sanitizeHeaders(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key).toLowerCase();
    if (!HEADER_NAME_RE.test(name)) continue;
    if (!SAFE_HEADERS.has(name)) continue;
    if (typeof value !== 'string' || value.length > 200) continue;
    if (/[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * 白名单构造：models.json 里只认这些字段，其余一律不展开。
 * 返回 null 表示该 provider 条目不可用（会被跳过并记进 rejected）。
 */
function sanitizeProvider(incoming, base) {
  if (!incoming || typeof incoming !== 'object') return null;
  if (typeof incoming.id !== 'string' || incoming.id.length === 0 || incoming.id.length > 64) return null;
  if (incoming.id === '__proto__' || incoming.id === 'constructor' || incoming.id === 'prototype') return null;

  const baseUrlRaw = incoming.baseUrl ?? base.baseUrl ?? null;
  const baseUrl = baseUrlRaw === null ? null : safeBaseUrl(baseUrlRaw);
  if (baseUrlRaw !== null && baseUrl === null) return null;

  const keyEnvRaw = incoming.apiKeyEnv ?? base.apiKeyEnv ?? null;
  if (keyEnvRaw !== null && !API_KEY_ENV_RE.test(String(keyEnvRaw))) return null;

  const models = Array.isArray(incoming.models)
    ? incoming.models
        .filter((model) => model && typeof model.id === 'string' && model.id.length > 0 && model.id.length <= 200)
        .map((model) => ({ id: model.id, label: String(model.label ?? model.id).slice(0, 120) }))
    : (base.models ?? []).map((model) => ({ ...model }));

  return {
    id: incoming.id,
    label: String(incoming.label ?? base.label ?? incoming.id).slice(0, 120),
    baseUrl,
    apiKeyEnv: keyEnvRaw === null ? null : String(keyEnvRaw),
    callable: typeof incoming.callable === 'boolean' ? incoming.callable : Boolean(base.callable),
    ...(typeof incoming.reason === 'string' ? { reason: incoming.reason.slice(0, 300) } : base.reason ? { reason: base.reason } : {}),
    headers: sanitizeHeaders(incoming.headers ?? base.headers),
    models,
  };
}

/**
 * 读注册表：默认表 + models.json 覆盖（按 provider id 合并，models 数组整体替换）。
 * 文件损坏时退回默认表，并报告错误——不因为一个可选文件把摘要整体打死。
 * 非法条目（http 地址、可疑 header、非法 apiKeyEnv）被丢弃并记进 rejected。
 */
export function loadCatalog(dataDir) {
  const fallback = defaultCatalog();
  if (!dataDir) return { catalog: fallback, error: null, path: null, rejected: [] };

  const path = catalogPath(dataDir);
  if (!existsSync(path)) return { catalog: fallback, error: null, path, rejected: [] };

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { catalog: fallback, error: `PARSE:${err.message}`, path, rejected: [] };
  }

  if (!raw || !Array.isArray(raw.providers)) {
    return { catalog: fallback, error: 'BAD_SHAPE', path, rejected: [] };
  }

  const byId = new Map(fallback.providers.map((provider) => [provider.id, provider]));
  const rejected = [];

  for (const incoming of raw.providers) {
    if (!incoming || typeof incoming.id !== 'string') {
      rejected.push('NO_ID');
      continue;
    }
    const base = byId.get(incoming.id) ?? {};
    const merged = sanitizeProvider(incoming, base);
    if (!merged) {
      rejected.push(incoming.id.slice(0, 64));
      continue;
    }
    byId.set(merged.id, merged);
  }

  return { catalog: { providers: [...byId.values()] }, error: null, path, rejected };
}
