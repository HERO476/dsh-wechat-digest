/**
 * 设置 API 的共享实现：本地设置页脚本与 DSH 插件宿主半都用这一份，避免行为分叉。
 *
 * 路由/传输层只负责搬 JSON，真正的读写、校验、fail-closed 都在这里。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configPath, loadConfig, saveConfig, defaultConfig, toPolicy, WEEKDAYS } from './config.js';
import { createFileAdapter } from './adapters/file.js';
import { createFileStore } from './store-file.js';
import { createService } from './service.js';
import { createSummarizerFromConfig } from './summarizer-factory.js';
import { renderDigest } from './summarize.js';
import { canonicalize } from './core/canonical.js';
import { roomHandle } from './core/gate.js';
import { loadCatalog, findModel } from './models.js';
import { resolveLlmConfig } from './llm-config.mjs';

const WEEKDAY_LABEL = { MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六', SU: '周日' };

/** 导出目录默认值由模块位置推导，不写死绝对路径（项目搬家也不会断）。 */
const DEFAULT_EXPORT_DIR = fileURLToPath(new URL('../exports', import.meta.url));

export function resolvePaths(env = process.env) {
  return {
    dataDir: env.WECHAT_DIGEST_DATA_DIR ?? join(homedir(), '.dsh', 'wechat-digest'),
    exportDir: env.WECHAT_DIGEST_EXPORT_DIR ?? DEFAULT_EXPORT_DIR,
  };
}

async function discoverRooms(exportDir, config = null) {
  /** 配置里自定义的名字优先，其次是导出目录里声明的名字。 */
  const nameOf = (key, fallback) => {
    const custom =
      config?.groups?.[key]?.name ??
      config?.private?.chats?.[key]?.name ??
      null;
    return custom && custom.trim().length > 0 ? custom : fallback;
  };

  const shape = (room) => {
    const canon = canonicalize(room.rawId);
    const key = canon.ok ? canon.canonicalId : room.rawId;
    return { key, name: nameOf(key, room.name ?? '(未命名)') };
  };

  try {
    const adapter = createFileAdapter({ exportRoot: exportDir });
    const all = await adapter.listRooms();
    return {
      groups: all.filter((room) => room.authoritativeKind === 'group').map(shape),
      privates: all.filter((room) => room.authoritativeKind === 'private').map(shape),
      error: null,
    };
  } catch (err) {
    return { groups: [], privates: [], error: String(err?.code ?? err?.message ?? err) };
  }
}

/** @returns {Promise<object>} 设置页需要的全部状态 */
export async function getState(paths = resolvePaths()) {
  const configFile = configPath(paths.dataDir);
  const { config, error } = loadConfig(configFile);
  const { groups, privates, error: roomsError } = await discoverRooms(paths.exportDir, config);
  const { catalog, error: catalogError } = loadCatalog(paths.dataDir);

  // 每个 provider 标注是否真的能调（有 key 且声明了 baseUrl）
  const providers = catalog.providers.map((provider) => {
    const availability = resolveLlmConfig({
      providerId: provider.id,
      modelId: provider.models?.[0]?.id,
      dataDir: paths.dataDir,
    });
    return {
      id: provider.id,
      label: provider.label ?? provider.id,
      callable: Boolean(provider.callable),
      reason: provider.callable ? availability.reason : provider.reason ?? availability.reason,
      keyEnv: provider.apiKeyEnv ?? null,
      models: (provider.models ?? []).map((model) => ({ id: model.id, label: model.label ?? model.id })),
    };
  });

  const selected = resolveLlmConfig({
    providerId: config.llm?.provider,
    modelId: config.llm?.model,
    dataDir: paths.dataDir,
  });

  return {
    config,
    configError: error,
    roomsError,
    catalogError,
    configPath: configFile,
    exportDir: paths.exportDir,
    groups,
    privates,
    rooms: groups, // 兼容旧页面
    weekdays: WEEKDAYS.map((day) => ({ id: day, label: WEEKDAY_LABEL[day] })),
    providers,
    selectedModel: {
      provider: config.llm?.provider ?? null,
      model: config.llm?.model ?? null,
      available: selected.available,
      reason: selected.reason,
      label: selected.available ? `${selected.providerLabel} / ${selected.modelLabel}` : null,
    },
  };
}

/** 保存配置；非法输入抛错（不写盘）。模型必须存在于注册表。 */
export function postConfig(payload, paths = resolvePaths()) {
  if (payload && typeof payload === 'object' && payload.llm) {
    const { catalog } = loadCatalog(paths.dataDir);
    const found = findModel(catalog, payload.llm.provider, payload.llm.model);
    if (!found) {
      const err = new Error(`UNKNOWN_MODEL:${payload.llm.provider}/${payload.llm.model}`);
      err.code = 'UNKNOWN_MODEL';
      throw err;
    }
  }
  const saved = saveConfig(configPath(paths.dataDir), payload);
  return { ok: true, config: saved };
}

/** 恢复默认。 */
export function postReset(paths = resolvePaths()) {
  const saved = saveConfig(configPath(paths.dataDir), defaultConfig());
  return { ok: true, config: saved };
}

/**
 * 句柄密钥：必须与 MCP 侧一致，否则同一个群算出不同句柄，get_summary 就查不到。
 * 两边都用这个解析函数，默认值是同一个常量。
 */
export function resolveSecret(env = process.env) {
  return env.WECHAT_DIGEST_SECRET ?? 'local-dev-secret-0123456789';
}

/**
 * 立即总结：在**当前进程**里跑一次，结果写进与 MCP 相同的 digests.jsonl。
 *
 * 注意：这里不走 IPC——设置页（宿主进程）和 MCP 服务器是两个进程，
 * 但它们共用同一个数据目录与同一套策略/闸门，所以行为一致。
 */
export async function postRun(paths = resolvePaths()) {
  const configFile = configPath(paths.dataDir);
  const { config, error } = loadConfig(configFile);

  const secret = resolveSecret();
  const adapter = createFileAdapter({ exportRoot: paths.exportDir });

  // 先算 handle → 名字，结果里按名字显示（不泄露原始会话 id）
  const nameByHandle = new Map();
  try {
    for (const room of await adapter.listRooms()) {
      const canon = canonicalize(room.rawId);
      if (!canon.ok) continue;
      const custom =
        config.groups?.[canon.canonicalId]?.name ?? config.private?.chats?.[canon.canonicalId]?.name;
      const name = custom && custom.trim().length > 0 ? custom : room.name ?? canon.canonicalId;
      nameByHandle.set(roomHandle(secret, canon.canonicalId), name);
    }
  } catch {
    // 导出目录不可读时交给 service 报错，这里不重复
  }

  const store = createFileStore({ dir: paths.dataDir });
  const before = store.all().length;

  const service = createService({
    adapter,
    secret,
    // 配置损坏时 loadConfig 已给出 fail-closed 策略
    getPolicy: () => toPolicy(config),
    summarize: ({ messages }) =>
      createSummarizerFromConfig(config, { dataDir: paths.dataDir })({ messages }),
    store,
  });

  const result = await service.runSummary({ trigger: 'manual' });
  const created = store.all().slice(before);

  return {
    ok: result.status === 'COMPLETED',
    status: result.status,
    configError: error,
    summarized: created.length,
    skipped: (result.skipped ?? []).length,
    denied: (result.denied ?? []).length,
    error: result.code ?? result.reason ?? null,
    items: created.map((entry) => ({
      roomHandle: entry.roomHandle,
      name: nameByHandle.get(entry.roomHandle) ?? null,
      seqFrom: entry.provenance.seqFrom,
      seqTo: entry.provenance.seqTo,
      text: renderDigest(entry.digest),
    })),
  };
}
