#!/usr/bin/env node
/**
 * 模型摘要连通性验证：用两条**假数据**跑一次真实调用。
 *
 * 跑法：
 *   node scripts/llm-smoke.mjs                      # 用配置里选中的模型
 *   node scripts/llm-smoke.mjs <provider> <model>    # 指定模型
 *   node scripts/llm-smoke.mjs --list                # 只列出注册表里的全部模型
 *
 * 注意：真实调用会消耗额度（一次很小的请求）。
 */
import { resolvePaths } from '../src/settings-api.js';
import { configPath, loadConfig } from '../src/config.js';
import { loadCatalog } from '../src/models.js';
import { resolveLlmConfig } from '../src/llm-config.mjs';
import { createLlmSummarizer } from '../src/summarize-llm.js';
import { renderDigest } from '../src/summarize.js';

const paths = resolvePaths();
const { catalog } = loadCatalog(paths.dataDir);

if (process.argv[2] === '--list') {
  for (const provider of catalog.providers) {
    const avail = resolveLlmConfig({ providerId: provider.id, modelId: provider.models?.[0]?.id, dataDir: paths.dataDir });
    console.log(`\n${provider.label ?? provider.id}  [${provider.id}]`);
    console.log(`  可调用: ${avail.available ? '是' : '否'}${avail.available ? '' : ' — ' + avail.reason}`);
    for (const model of provider.models ?? []) console.log(`    - ${model.id}  (${model.label})`);
  }
  process.exit(0);
}

const { config } = loadConfig(configPath(paths.dataDir));
const providerId = process.argv[2] ?? config.llm?.provider;
const modelId = process.argv[3] ?? config.llm?.model;

const resolved = resolveLlmConfig({ providerId, modelId, dataDir: paths.dataDir });

console.log(`provider  ${resolved.providerLabel ?? providerId}`);
console.log(`model     ${resolved.modelLabel ?? modelId}`);
console.log(`baseUrl   ${resolved.baseUrl ?? '(无)'}`);
console.log(`key 来源  ${resolved.apiKeySource}`);

if (!resolved.available) {
  console.error(`不可调用：${resolved.reason}`);
  process.exit(1);
}

const summarize = createLlmSummarizer({
  baseUrl: resolved.baseUrl,
  apiKey: resolved.apiKey,
  model: resolved.modelId,
  headers: resolved.headers,
});

const messages = [
  { seq: 1, at: '2026-11-10 09:12', sender: '小王', text: '周五前把评审稿交上来（这是测试数据，不是真实聊天记录）' },
  { seq: 2, at: '2026-11-10 09:15', sender: '老李', text: '待办：确认服务器预算，截止周三（这是测试数据）' },
  { seq: 3, at: '2026-11-10 09:20', sender: '小张', text: '@小王 数据口径按上周定的来（这是测试数据）' },
];

try {
  const digest = await summarize({ messages });
  console.log('\n== 结构化结果 ==');
  console.log(JSON.stringify({ tasks: digest.tasks, activities: digest.activities, mentions: digest.mentions }, null, 2));
  console.log('\n== 渲染 ==');
  console.log(renderDigest(digest));
  console.log('\n结论：该模型可用于摘要。');
} catch (err) {
  console.error(`\n失败：${err.code ?? 'UNKNOWN'} — ${err.message}`);
  process.exitCode = 1;
}
