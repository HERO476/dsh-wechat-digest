/**
 * 文件适配器：读你手动导出的聊天记录。
 *
 * 为什么要有它：沙箱内拿不到解密密钥（Low IL 读不了微信进程内存），
 * 但你完全可以把群聊消息复制出来存成文件。这样零权限、零 ToS 风险、零误发可能，
 * 而且闸门、策略、双哨兵这些保护**一行都不用改**——它们对任何数据源都生效。
 *
 * 目录约定（每个会话一个子目录）：
 *   <exportRoot>/<slug>/
 *     room.json      { "name": "产品评审群", "kind": "group", "id": "prod-review" }
 *     messages.txt   [2026-11-10 09:12] 小王: 周五前交评审稿
 *   或
 *     messages.jsonl {"at":"2026-11-10T09:12:00+08:00","sender":"小王","text":"周五前交评审稿"}
 *
 * 注意房间类型来自 room.json 的显式声明，**不是**从内容里猜的。
 * 声明为 private 的目录默认会被闸门拒绝——这正是我们要的效果：
 * 你可以把私聊也放进来，它不会因为"存在"就被读。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FILE_ERROR = Object.freeze({
  EXPORT_ROOT_MISSING: 'EXPORT_ROOT_MISSING',
  ROOM_INVALID: 'ROOM_INVALID',
  MESSAGES_MISSING: 'MESSAGES_MISSING',
});

const SAFE_SLUG = /^[a-z0-9_-]{1,64}$/i;
const KINDS = new Set(['group', 'private', 'excluded']);

const TEXT_LINE = /^\[([^\]]+)\]\s*([^:：]+)[:：]\s*(.*)$/;

function fail(code, message) {
  const err = new Error(message ?? code);
  err.code = code;
  return err;
}

/** 由 kind + 声明的 id 合成一个形态正确的会话 id，供闸门分类用。 */
function buildRawId(kind, id) {
  if (kind === 'group') return `${id}@chatroom`;
  if (kind === 'excluded') return `gh_${id}`;
  return id.startsWith('wxid_') ? id : `wxid_${id}`;
}

function parseTextLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const match = TEXT_LINE.exec(line);
      if (match) {
        return { seq: index + 1, at: match[1].trim(), sender: match[2].trim(), text: match[3].trim() };
      }
      return { seq: index + 1, at: null, sender: null, text: line };
    });
}

function parseJsonl(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw fail(FILE_ERROR.ROOM_INVALID, `messages.jsonl 有一行不是合法 JSON: ${line.slice(0, 40)}`);
    }
    rows.push({
      seq: rows.length + 1,
      at: row.at ?? null,
      sender: row.sender ?? null,
      text: String(row.text ?? ''),
    });
  }
  return rows;
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {{exportRoot:string}} options
 */
export function createFileAdapter({ exportRoot } = {}) {
  /** @type {Map<string, Array>} */
  let cache = new Map();
  let loaded = false;

  async function load() {
    if (!exportRoot) throw fail(FILE_ERROR.EXPORT_ROOT_MISSING, '未配置 exportRoot');

    let entries;
    try {
      entries = await readdir(exportRoot, { withFileTypes: true });
    } catch {
      throw fail(FILE_ERROR.EXPORT_ROOT_MISSING, `导出目录不可读: ${exportRoot}`);
    }

    const rooms = [];
    cache = new Map();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(exportRoot, entry.name);
      const metaText = await readIfExists(join(dir, 'room.json'));
      if (metaText === null) continue;

      let meta;
      try {
        meta = JSON.parse(metaText);
      } catch {
        throw fail(FILE_ERROR.ROOM_INVALID, `${entry.name}/room.json 不是合法 JSON`);
      }

      const kind = String(meta.kind ?? '');
      const id = String(meta.id ?? '');
      if (!KINDS.has(kind)) throw fail(FILE_ERROR.ROOM_INVALID, `${entry.name}: kind 必须是 group/private/excluded`);
      if (!SAFE_SLUG.test(id)) throw fail(FILE_ERROR.ROOM_INVALID, `${entry.name}: id 只能用字母数字下划线（不能带路径）`);

      const rawId = buildRawId(kind, id);

      let messages = null;
      const jsonl = await readIfExists(join(dir, 'messages.jsonl'));
      if (jsonl !== null) messages = parseJsonl(jsonl);
      else {
        const txt = await readIfExists(join(dir, 'messages.txt'));
        if (txt !== null) messages = parseTextLines(txt);
      }
      if (messages === null) throw fail(FILE_ERROR.MESSAGES_MISSING, `${entry.name}: 缺少 messages.txt 或 messages.jsonl`);

      cache.set(rawId, messages);
      rooms.push({ rawId, name: meta.name ?? entry.name, authoritativeKind: kind });
    }

    loaded = true;
    return rooms;
  }

  return {
    name: 'file',
    // 文件模式是"全量快照"：每次读取都是完整一份，因此不使用增量水位线。
    stateless: true,
    async listRooms() {
      return load();
    },
    async fetchMessages({ room, fromSeq = 0 }) {
      if (!loaded) await load();
      const all = cache.get(room.rawId) ?? [];
      return all.filter((message) => message.seq > fromSeq).map((message) => ({ ...message }));
    },
  };
}
