#!/usr/bin/env node
/**
 * MCP stdio 服务器：把三个工具暴露给 DSH。
 *
 * 工具语义（与 toolSurface 一致，不允许文案漂移）：
 *  - list_rooms / get_summary 只读本地文件；
 *  - run_summary 会写摘要文件、会调用模型服务（出网 + 计费），因此 annotations.readOnlyHint=false。
 *
 * 配置来源：~/.dsh/wechat-digest/config.json（由设置页编辑）。
 * 每次调用都会重新读取配置，所以**改完设置立即生效，不需要重启**。
 *
 * 环境变量（一般不用动，run-mcp.mjs 会设好默认值）：
 *   WECHAT_DIGEST_SOURCE      fixture | file | wechat
 *   WECHAT_DIGEST_SECRET      句柄 HMAC 密钥（不给则读 <dataDir>/secret，首次自动生成）
 *   WECHAT_DIGEST_EXPORT_DIR  file 模式的导出根目录
 *   WECHAT_DIGEST_DATA_DIR    配置与摘要落盘目录
 *
 * 注意：本文件不导出任何发送类方法，整个进程只有读 + 写本地摘要。
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { createFixtureAdapter, DEFAULT_FIXTURE } from './adapters/fixture.js';
import { createFileAdapter } from './adapters/file.js';
import { createWeChatAdapter } from './adapters/wechat.js';
import { createFileStore } from './store-file.js';
import { createFileLock } from './run-lock.js';
import { resolveSecret, describeSecret } from './secret-store.js';
import { configPath, loadConfig, toPolicy, defaultConfig } from './config.js';
import { createSummarizerFromConfig } from './summarizer-factory.js';
import { createService } from './service.js';
import { createToolHandlers } from './tools.js';
import { createProtocol } from './mcp-protocol.js';
import { TOOLS } from './core/toolSurface.js';
import { resolveLlmConfig } from './llm-config.mjs';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const SERVER_VERSION = PACKAGE.version;
const SERVER_NAME = PACKAGE.name;

const DATA_DIR = process.env.WECHAT_DIGEST_DATA_DIR ?? null;

let SECRET;
try {
  const resolved = resolveSecret({ dataDir: DATA_DIR ?? undefined });
  SECRET = resolved.secret;
  process.stderr.write(`[wechat-digest] 句柄密钥来源=${describeSecret(resolved)}\n`);
} catch (err) {
  process.stderr.write(`[wechat-digest] 句柄密钥不可用：${err?.code ?? err?.message ?? err}\n`);
  process.exit(1);
}
if (SECRET.length < 16) {
  process.stderr.write('句柄密钥必须至少 16 字符\n');
  process.exit(1);
}

const SOURCE = process.env.WECHAT_DIGEST_SOURCE ?? 'fixture';

const adapter =
  SOURCE === 'wechat'
    ? createWeChatAdapter({
        dataRoot: process.env.WECHAT_DIGEST_DATA_ROOT,
        account: process.env.WECHAT_DIGEST_ACCOUNT,
      })
    : SOURCE === 'file'
      ? createFileAdapter({ exportRoot: process.env.WECHAT_DIGEST_EXPORT_DIR })
      : createFixtureAdapter(DEFAULT_FIXTURE);

const CONFIG_FILE = DATA_DIR ? configPath(DATA_DIR) : null;

const bootSelection = loadConfig(CONFIG_FILE ? CONFIG_FILE : null);
const bootLlm = resolveLlmConfig({
  providerId: bootSelection.config?.llm?.provider,
  modelId: bootSelection.config?.llm?.model,
  dataDir: DATA_DIR,
});
if (!bootLlm.available) {
  process.stderr.write(`[wechat-digest] 模型不可用：${bootLlm.reason}\n`);
} else {
  process.stderr.write(
    `[wechat-digest] 模型=${bootLlm.providerLabel}/${bootLlm.modelLabel} 密钥来源=${bootLlm.apiKeySource}\n`,
  );
}

/** 每次调用都重读配置：设置页改完立即生效。 */
function readConfig() {
  if (!CONFIG_FILE) {
    return { config: { summarizer: 'heuristic', groups: {}, private: { enabled: false } }, error: null, policy: toPolicy(defaultConfig()) };
  }
  return loadConfig(CONFIG_FILE);
}

const service = createService({
  adapter,
  secret: SECRET,
  // 策略每次运行重新算；配置损坏时 loadConfig 已给出 fail-closed 策略
  getPolicy: () => readConfig().policy,
  // 摘要器也每次按当前配置构造（provider/model 都来自配置，可随时切换）
  summarize: ({ messages }) => {
    const { config } = readConfig();
    return createSummarizerFromConfig(config, { dataDir: DATA_DIR })({ messages });
  },
  ...(DATA_DIR ? { store: createFileStore({ dir: DATA_DIR }) } : {}),
  // 跨进程互斥：设置页与工具可能同时触发，内存锁管不住另一个进程。
  ...(DATA_DIR ? { lock: createFileLock({ dir: DATA_DIR }) } : {}),
});

const handlers = createToolHandlers(service);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const protocol = createProtocol({
  handlers,
  tools: TOOLS,
  send,
  serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
});

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  void protocol.handleLine(line);
});
