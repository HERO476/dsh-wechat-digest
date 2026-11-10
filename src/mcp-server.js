#!/usr/bin/env node
/**
 * MCP stdio 服务器：把三个只读工具暴露给 DSH。
 *
 * 配置来源：~/.dsh/wechat-digest/config.json（由设置页编辑）。
 * 每次调用都会重新读取配置，所以**改完设置立即生效，不需要重启**。
 *
 * 环境变量（一般不用动，run-mcp.mjs 会设好默认值）：
 *   WECHAT_DIGEST_SOURCE      fixture | file | wechat
 *   WECHAT_DIGEST_SECRET      句柄 HMAC 密钥
 *   WECHAT_DIGEST_EXPORT_DIR  file 模式的导出根目录
 *   WECHAT_DIGEST_DATA_DIR    配置与摘要落盘目录
 *
 * 注意：本文件不导出任何发送类方法，整个进程只有读。
 */

import { createInterface } from 'node:readline';

import { createFixtureAdapter, DEFAULT_FIXTURE } from './adapters/fixture.js';
import { createFileAdapter } from './adapters/file.js';
import { createWeChatAdapter } from './adapters/wechat.js';
import { createFileStore } from './store-file.js';
import { configPath, loadConfig, toPolicy, defaultConfig } from './config.js';
import { createSummarizerFromConfig } from './summarizer-factory.js';
import { createService } from './service.js';
import { createToolHandlers } from './tools.js';
import { TOOLS } from './core/toolSurface.js';
import { resolveLlmConfig } from './llm-config.mjs';

const SECRET = process.env.WECHAT_DIGEST_SECRET ?? 'local-dev-secret-0123456789';
if (SECRET.length < 16) {
  process.stderr.write('WECHAT_DIGEST_SECRET 必须至少 16 字符\n');
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

const DATA_DIR = process.env.WECHAT_DIGEST_DATA_DIR;
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
});

const handlers = createToolHandlers(service);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const text = line.trim();
  if (text.length === 0) return;

  let request;
  try {
    request = JSON.parse(text);
  } catch {
    return;
  }

  const { id, method, params } = request ?? {};

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'wechat-digest', version: '0.1.0' },
        },
      });
      return;
    }

    if (method === 'notifications/initialized') return;

    if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      });
      return;
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const handler = handlers[name];
      if (!handler) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'UNKNOWN_TOOL' }], isError: true } });
        return;
      }
      try {
        const output = await handler(params?.arguments ?? {});
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], isError: false },
        });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: String(err?.code ?? err?.message ?? err) }],
            isError: true,
          },
        });
      }
      return;
    }

    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'METHOD_NOT_FOUND' } });
    }
  } catch (err) {
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(err?.message ?? err) } });
    }
  }
});
