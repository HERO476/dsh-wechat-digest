/**
 * 设置 API 的共享实现：本地设置页脚本与 DSH 插件宿主半都用这一份，避免行为分叉。
 *
 * 路由/传输层只负责搬 JSON，真正的读写、校验、fail-closed 都在这里。
 *
 * 数据最小化（对外响应里不出现的东西）：
 *  - 原始会话 id：只给 HMAC 句柄（roomHandle），保存时由服务端把句柄翻回 canonicalId；
 *  - 宿主机绝对路径：只给目录名，不给完整路径。
 */

import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configPath, loadConfig, saveConfig, defaultConfig, toPolicy, WEEKDAYS } from './config.js';
import { createFileAdapter } from './adapters/file.js';
import { createFileStore } from './store-file.js';
import { createFileLock } from './run-lock.js';
import { createService } from './service.js';
import { createSummarizerFromConfig } from './summarizer-factory.js';
import { renderDigest } from './summarize.js';
import { canonicalize } from './core/canonical.js';
import { roomHandle } from './core/gate.js';
import { resolveSecret as resolveSecretFromStore, describeSecret, defaultDataDir } from './secret-store.js';
import { loadCatalog, findModel } from './models.js';
import { resolveLlmConfig } from './llm-config.mjs';

const HANDLE_RE = /^[0-9a-f]{16}$/;

const WEEKDAY_LABEL = { MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六', SU: '周日' };

/** 导出目录默认值由模块位置推导，不写死绝对路径（项目搬家也不会断）。 */
const DEFAULT_EXPORT_DIR = fileURLToPath(new URL('../exports', import.meta.url));

export function resolvePaths(env = process.env) {
  return {
    dataDir: env.WECHAT_DIGEST_DATA_DIR ?? defaultDataDir(env),
    exportDir: env.WECHAT_DIGEST_EXPORT_DIR ?? DEFAULT_EXPORT_DIR,
  };
}

/** 句柄密钥：与 MCP 侧同一个来源（env 或 <dataDir>/secret），不再有默认常量。 */
export function resolveSecretFor(paths = resolvePaths(), env = process.env) {
  return resolveSecretFromStore({ env, dataDir: paths.dataDir });
}

/** 兼容旧导入名：只返回密钥字符串。 */
export function resolveSecret(env = process.env) {
  return resolveSecretFor(resolvePaths(env), env).secret;
}

/**
 * 建立 handle → 会话信息 的索引。句柄是唯一的对外标识；
 * canonicalId 只在本进程内存里用于落配置。
 */
async function buildRoomIndex(paths, env = process.env) {
  const { secret } = resolveSecretFor(paths, env);
  const map = new Map();
  try {
    const adapter = createFileAdapter({ exportRoot: paths.exportDir });
    for (const room of await adapter.listRooms()) {
      const canon = canonicalize(room.rawId);
      if (!canon.ok) continue;
      map.set(roomHandle(secret, canon.canonicalId), {
        canonicalId: canon.canonicalId,
        kind: canon.kind,
        name: room.name ?? null,
      });
    }
    return { map, error: null };
  } catch (err) {
    return { map, error: String(err?.code ?? err?.message ?? err) };
  }
}

/** @returns {Promise<object>} 设置页需要的全部状态（不含原始 id、不含绝对路径） */
export async function getState(paths = resolvePaths(), env = process.env) {
  const configFile = configPath(paths.dataDir);
  const { config, error } = loadConfig(configFile);
  const { map, error: roomsError } = await buildRoomIndex(paths, env);
  const { catalog, error: catalogError } = loadCatalog(paths.dataDir);

  const pickName = (value) => (typeof value === 'string' && value.trim().length > 0 ? value : null);
  const nameOf = (canonicalId, fallback) =>
    pickName(config.groups?.[canonicalId]?.name) ??
    pickName(config.private?.chats?.[canonicalId]?.name) ??
    fallback;

  const groups = [];
  const privates = [];
  const selected = { groups: {}, privateChats: {} };

  for (const [handle, info] of map) {
    const shaped = { roomHandle: handle, name: nameOf(info.canonicalId, info.name ?? '(未命名)') };
    const saved = config.groups?.[info.canonicalId] ?? config.private?.chats?.[info.canonicalId] ?? null;

    if (info.kind === 'group') {
      groups.push(shaped);
      if (saved) selected.groups[handle] = { ...saved };
    } else if (info.kind === 'private') {
      privates.push(shaped);
      if (saved) selected.privateChats[handle] = { ...saved };
    }
  }

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

  const selectedModel = resolveLlmConfig({
    providerId: config.llm?.provider,
    modelId: config.llm?.model,
    dataDir: paths.dataDir,
  });

  return {
    // 配置本体：groups / private.chats 一律清空，避免原始会话 id 出站。
    config: {
      ...config,
      groups: {},
      private: { enabled: config.private?.enabled === true, chats: {} },
    },
    // 已保存的勾选状态，按句柄索引（客户端用它渲染复选框）。
    selected,
    configError: error,
    roomsError,
    catalogError,
    dataDirName: basename(paths.dataDir),
    exportDirName: basename(paths.exportDir),
    groups,
    privates,
    rooms: groups, // 兼容旧页面
    weekdays: WEEKDAYS.map((day) => ({ id: day, label: WEEKDAY_LABEL[day] })),
    providers,
    selectedModel: {
      provider: config.llm?.provider ?? null,
      model: config.llm?.model ?? null,
      available: selectedModel.available,
      reason: selectedModel.reason,
      label: selectedModel.available ? `${selectedModel.providerLabel} / ${selectedModel.modelLabel}` : null,
    },
  };
}

/**
 * 把客户端提交的会话表（键可能是句柄，也可能是 canonicalId）翻成 canonicalId 键。
 * 翻不出来的句柄不静默丢：放进 unresolved 让界面提示。
 */
function translateRoomMap(rawMap, byHandle) {
  const out = {};
  const unresolved = [];
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return { out, unresolved };

  for (const [key, value] of Object.entries(rawMap)) {
    if (HANDLE_RE.test(key)) {
      const info = byHandle.get(key);
      if (!info) {
        unresolved.push(key);
        continue;
      }
      out[info.canonicalId] = value;
      continue;
    }
    const canon = canonicalize(key);
    if (!canon.ok) {
      unresolved.push(key);
      continue;
    }
    out[canon.canonicalId] = value;
  }

  return { out, unresolved };
}

/**
 * 保存配置；非法输入抛错（不写盘）。模型必须存在于注册表。
 * 异步：需要读导出目录才能把句柄翻回 canonicalId。
 */
export async function postConfig(payload, paths = resolvePaths(), env = process.env) {
  if (payload && typeof payload === 'object' && payload.llm) {
    const { catalog } = loadCatalog(paths.dataDir);
    const found = findModel(catalog, payload.llm.provider, payload.llm.model);
    if (!found) {
      const err = new Error(`UNKNOWN_MODEL:${payload.llm.provider}/${payload.llm.model}`);
      err.code = 'UNKNOWN_MODEL';
      throw err;
    }
  }

  let body = payload;
  const unresolved = [];

  if (payload && typeof payload === 'object') {
    const { map } = await buildRoomIndex(paths, env);
    const groups = translateRoomMap(payload.groups, map);
    unresolved.push(...groups.unresolved);

    body = { ...payload, groups: groups.out };

    // 只有客户端真的带了 private 才重建它：否则会把「缺省 enabled」变成 undefined，
    // 让 parseConfig 报 PRIVATE_ENABLED_NOT_BOOLEAN（而不是按默认值处理）。
    if (payload.private && typeof payload.private === 'object') {
      const chats = translateRoomMap(payload.private.chats, map);
      unresolved.push(...chats.unresolved);
      body.private = { ...payload.private, chats: chats.out };
    }
  }

  const saved = saveConfig(configPath(paths.dataDir), body);
  return {
    ok: true,
    config: {
      ...saved,
      groups: {},
      private: { enabled: saved.private?.enabled === true, chats: {} },
    },
    unresolvedHandles: unresolved,
  };
}

/** 恢复默认。 */
export function postReset(paths = resolvePaths()) {
  const saved = saveConfig(configPath(paths.dataDir), defaultConfig());
  return {
    ok: true,
    config: {
      ...saved,
      groups: {},
      private: { enabled: saved.private?.enabled === true, chats: {} },
    },
  };
}

/**
 * 总结一次：设置页与定时器都走这里，结果写进与 MCP 相同的 digests.jsonl。
 *
 * 与 MCP 子进程共用文件锁与数据目录，因此两路不会同时跑。
 */
export async function postRun(paths = resolvePaths(), { trigger = 'manual', env = process.env } = {}) {
  const configFile = configPath(paths.dataDir);
  const { config, error } = loadConfig(configFile);

  const { secret } = resolveSecretFor(paths, env);
  const adapter = createFileAdapter({ exportRoot: paths.exportDir });

  // 先算 handle → 名字，结果里按名字显示（不泄露原始会话 id）
  const nameByHandle = new Map();
  try {
    for (const room of await adapter.listRooms()) {
      const canon = canonicalize(room.rawId);
      if (!canon.ok) continue;
      const custom =
        config.groups?.[canon.canonicalId]?.name ?? config.private?.chats?.[canon.canonicalId]?.name;
      const name = custom && custom.trim().length > 0 ? custom : room.name ?? '(未命名)';
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
    lock: createFileLock({ dir: paths.dataDir }),
  });

  const result = await service.runSummary({ trigger });
  const created = store.all().slice(before);

  return {
    ok: result.status === 'COMPLETED',
    status: result.status,
    trigger,
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

export { describeSecret };
