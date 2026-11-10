/**
 * 摘要器工厂：按配置挑本地关键词规则或模型。
 * 支持注册表里的任意 provider/model；不可调用时抛出带原因的明确错误。
 */

import { createLlmSummarizer } from './summarize-llm.js';
import { summarizeMessages } from './summarize.js';
import { resolveLlmConfig } from './llm-config.mjs';

export function createSummarizerFromConfig(config, { dataDir, credentialsPath } = {}) {
  if (config?.summarizer !== 'llm') {
    return ({ messages }) => summarizeMessages({ messages });
  }

  const selection = config.llm ?? {};
  const resolved = resolveLlmConfig({
    providerId: selection.provider,
    modelId: selection.model,
    dataDir,
    credentialsPath,
  });

  if (!resolved.available) {
    const err = new Error(resolved.reason ?? 'LLM_UNAVAILABLE');
    err.code = 'LLM_UNAVAILABLE';
    throw err;
  }

  const summarize = createLlmSummarizer({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.modelId,
    headers: resolved.headers,
  });

  return ({ messages }) => summarize({ messages });
}
