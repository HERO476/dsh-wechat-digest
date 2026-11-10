/**
 * 会话标识归一化与分类：全系统唯一的解析点。
 *
 * 铁律：原始 chat id 只在这里解析一次。下游（闸门 / 漏斗 / 存储 / 日志）
 * 一律不得再对原始串做 split / endsWith / 正则判断，只能使用本函数返回的
 * { canonicalId, kind }。这样同一个会话不可能得到两种裁决。
 */

export const KIND = Object.freeze({
  GROUP: 'group',
  PRIVATE: 'private',
  EXCLUDED: 'excluded',
  UNKNOWN: 'unknown',
});

/** 系统号 / 服务助手：既不是群也不是人，显式排除。 */
const EXCLUDED_EXACT = new Set([
  'filehelper',
  'weixin',
  'weixinreminder',
  'fmessage',
  'medianote',
  'newsapp',
  'notifymessage',
  'qqmail',
  'qmessage',
  'tmessage',
  'voip',
  'weibo',
  'binding',
]);

/** 企业微信互通 / 公众号：外观像群或像人，但不是本项目要的群聊。 */
const EXCLUDED_SUFFIXES = ['@openim', '@im.chatroom'];
const EXCLUDED_PREFIXES = ['gh_'];

const MAX_ID_LENGTH = 200;
const CONTROL_OR_INVISIBLE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/;

/**
 * @param {unknown} rawId
 * @returns {{ok:true, canonicalId:string, kind:string} | {ok:false, reason:string}}
 */
export function canonicalize(rawId) {
  if (typeof rawId !== 'string') return { ok: false, reason: 'NOT_STRING' };

  const trimmed = rawId.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'EMPTY' };
  if (trimmed.length > MAX_ID_LENGTH) return { ok: false, reason: 'TOO_LONG' };
  if (CONTROL_OR_INVISIBLE.test(trimmed)) return { ok: false, reason: 'CONTROL_OR_INVISIBLE' };

  // 后缀大小写不敏感：@CHATROOM 与 @chatroom 是同一个会话。
  // 注意：不剥前导零。01234567@chatroom 与 1234567@chatroom 视为不同 id，
  // 但两者 kind 相同，因此裁决一致——这里保证的是「不出现两种结论」，
  // 不保证「两个不同 id 被合并」。
  const canonicalId = trimmed.toLowerCase();
  return { ok: true, canonicalId, kind: classify(canonicalId) };
}

function classify(id) {
  for (const suffix of EXCLUDED_SUFFIXES) {
    if (id.endsWith(suffix)) return KIND.EXCLUDED;
  }
  for (const prefix of EXCLUDED_PREFIXES) {
    if (id.startsWith(prefix)) return KIND.EXCLUDED;
  }
  if (EXCLUDED_EXACT.has(id)) return KIND.EXCLUDED;

  // 群：唯一认可的形态
  if (id.endsWith('@chatroom')) return KIND.GROUP;

  // 私聊：wxid_ 开头，或形如自定义微信号（字母开头、无 @）
  if (id.startsWith('wxid_')) return KIND.PRIVATE;
  if (/^[a-z][a-z0-9_-]{5,19}$/.test(id)) return KIND.PRIVATE;

  // 其余一律未知 → 闸门 fail-closed 拒绝
  return KIND.UNKNOWN;
}
