/**
 * 模型配置解析：把「选中的 provider + model」解析成可调用的参数。
 *
 * 原则：
 *  - 支持注册表里的**所有** provider（DeepSeek 官方 / Command Code / OpenCode Go …）；
 *  - 不可调用的 provider（如账号登录态 OAuth）明确返回 available:false + 原因，
 *    不假装能跑；
 *  - 密钥优先环境变量，其次 DSH 凭据文件里的**同名键**（apiKeyEnv）；
 *    值只进内存，任何地方都不打印。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadCatalog, findModel, firstCallable } from './models.js';

export function defaultCredentialsPath() {
  return join(homedir(), '.dsh', '.credentials.yaml');
}

/** 从 DSH 凭据文件里取一个 refs.* 的值。只做窄匹配，不解析整份 YAML。 */
export function readCredential(name, { credentialsPath = defaultCredentialsPath() } = {}) {
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) return null;

  let text;
  try {
    text = readFileSync(credentialsPath, 'utf8');
  } catch {
    return null;
  }

  const match = new RegExp(`^\\s{2}${name}:\\s*(.+)$`, 'm').exec(text);
  if (!match) return null;

  const value = match[1].trim().replace(/^["']/, '').replace(/["']$/, '');
  return value.length > 0 ? value : null;
}

/**
 * @returns {{
 *   available:boolean, reason:string|null,
 *   providerId:string, providerLabel:string|null,
 *   modelId:string, modelLabel:string|null,
 *   baseUrl:string|null, headers:object, apiKey:string|null, apiKeySource:string,
 *   catalogError:string|null
 * }}
 */
export function resolveLlmConfig(options = {}) {
  const {
    providerId,
    modelId,
    env = process.env,
    credentialsPath,
    dataDir = env.WECHAT_DIGEST_DATA_DIR,
  } = options;

  const { catalog, error: catalogError } = loadCatalog(dataDir ?? null);

  const selection =
    providerId && modelId ? { providerId, modelId } : firstCallable(catalog);

  const found = findModel(catalog, selection.providerId, selection.modelId);
  if (!found) {
    return {
      available: false,
      reason: `注册表里没有这个模型：${selection.providerId} / ${selection.modelId}`,
      providerId: selection.providerId,
      providerLabel: null,
      modelId: selection.modelId,
      modelLabel: null,
      baseUrl: null,
      headers: {},
      apiKey: null,
      apiKeySource: 'none',
      catalogError,
    };
  }

  const { provider, model } = found;
  const base = {
    providerId: provider.id,
    providerLabel: provider.label ?? provider.id,
    modelId: model.id,
    modelLabel: model.label ?? model.id,
    baseUrl: provider.baseUrl ?? null,
    headers: provider.headers ?? {},
    apiKey: null,
    apiKeySource: 'none',
    catalogError,
  };

  if (!provider.callable) {
    return { ...base, available: false, reason: provider.reason ?? '该 provider 不支持直接调用' };
  }
  if (!provider.baseUrl) {
    return { ...base, available: false, reason: '该 provider 没有配置 baseUrl' };
  }

  const keyEnv = provider.apiKeyEnv;
  let apiKey = keyEnv ? env[keyEnv] || null : null;
  let apiKeySource = apiKey ? 'env' : 'none';

  if (!apiKey && keyEnv) {
    apiKey = readCredential(keyEnv, credentialsPath ? { credentialsPath } : {});
    if (apiKey) apiKeySource = 'credentials';
  }

  if (!apiKey) {
    return {
      ...base,
      available: false,
      reason: keyEnv ? `缺少密钥：${keyEnv}（环境变量或 ~/.dsh/.credentials.yaml）` : '该 provider 未声明密钥变量',
    };
  }

  return { ...base, available: true, reason: null, apiKey, apiKeySource };
}
