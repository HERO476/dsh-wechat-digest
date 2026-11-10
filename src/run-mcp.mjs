/**
 * MCP 启动包装：把默认配置固化在进程内，供 profile 直接调用。
 *
 * 为什么不把 env 写进 cordis.patch.yml：我不确定该客户端配置是否支持 `env` 键，
 * 一个不支持的键可能让整个 profile 起不来。写成包装脚本就与配置 schema 无关。
 * （事后在 ~/.dsh/cordis.patch.yml 的 rea-mcp 条目里见到 env 是支持的，
 *  但保留包装脚本仍有用：它负责推导导出目录与模型配置。）
 *
 * 句柄密钥：**不在这里设默认值**。由 mcp-server.js 通过 secret-store 解析
 * （环境变量 → <dataDir>/secret，首次自动生成 32 字节随机值），
 * 这样仓库里不再存在一个公开的固定密钥，宿主半与子进程也共用同一份。
 *
 * 模型密钥：优先环境变量 WECHAT_DIGEST_LLM_API_KEY，
 * 否则运行时从 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY 读取。
 * 密钥只进内存，不打印、不落盘。
 */

import { resolveLlmConfig } from './llm-config.mjs';
import { createFileStore } from './store-file.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 由模块位置推导，不写死绝对路径
const DEFAULT_EXPORT_DIR = fileURLToPath(new URL('../exports', import.meta.url));

process.env.WECHAT_DIGEST_SOURCE ??= 'file';
process.env.WECHAT_DIGEST_EXPORT_DIR ??= DEFAULT_EXPORT_DIR;
process.env.WECHAT_DIGEST_DATA_DIR ??= join(homedir(), '.dsh', 'wechat-digest');

const summarizerMode = process.env.WECHAT_DIGEST_SUMMARIZER ?? 'llm';

if (summarizerMode === 'llm') {
  const llm = resolveLlmConfig();
  process.env.WECHAT_DIGEST_LLM_BASE_URL ??= llm.baseUrl;
  process.env.WECHAT_DIGEST_LLM_MODEL ??= llm.model;
  if (llm.apiKey) process.env.WECHAT_DIGEST_LLM_API_KEY ??= llm.apiKey;

  // 只报来源，不报值
  process.stderr.write(
    `[wechat-digest] 摘要器=llm model=${llm.model} key来源=${llm.apiKeySource}\n`,
  );

  if (llm.apiKeySource === 'none') {
    process.stderr.write(
      '[wechat-digest] 警告：未找到模型密钥，摘要调用会返回 SUMMARIZE_HTTP_401。' +
        '可在 ~/.dsh/.credentials.yaml 配置 DEEPSEEK_API_KEY，或设 WECHAT_DIGEST_SUMMARIZER=heuristic。\n',
    );
  }
}

process.env.WECHAT_DIGEST_SUMMARIZER = summarizerMode;

await import('./mcp-server.js');
