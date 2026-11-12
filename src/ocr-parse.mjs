/**
 * 截图 OCR 结果的解析层（纯函数，可测试）。
 *
 * 输入：Windows OCR 输出的行（含文本与边框坐标），例如
 *   { text: '周 五 前 把 评 审 稿 交 上 来', x: 40, y: 100, w: 520, h: 24 }
 *
 * 输出：`[时间] 发送者: 内容` 形式的行——正是 exports/<群>/messages.txt 需要的格式。
 *
 * 为什么要单独一层：OCR 会把中文字符之间插空格、把全角冒号读成半角、
 * 把小号灰字（发送者名）读丢。这些修正在这里做，采集脚本只管截屏与识别。
 */

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';

/** 去掉 CJK 之间被 OCR 插入的空格。 */
export function squeezeCjk(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g'), '$1')
    .replace(new RegExp(`([${CJK}])\\s+(?=[，。！？、；：（）《》“”‘’…—])`, 'g'), '$1')
    .replace(new RegExp(`([，。！？、；：（）《》“”‘’…—])\\s+(?=[${CJK}])`, 'g'), '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 全角冒号/时间分隔符归一。 */
export function normalizePunct(text) {
  return text
    .replace(/：/g, ':')
    // OCR 会把 "09 ： 12" 读成带空格的冒号：先收拢，再交给时间判定
    .replace(/\s*:\s*/g, ':')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48))
    .replace(/[／]/g, '/')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 时间标记：09:12 / 昨天 09:12 / 2026年11月10日 09:12 / 周三 09:12。
 *
 * 不写死严格格式：真实 OCR 会把 "2026年11月10日" 读成 "2026 年 1 1 10 日"、把 "月" 读丢。
 * 判据改为「去掉空格后很短 + 含 HH:MM + 不像句子」，对乱码更稳。
 */
export function isTimeMarker(text) {
  const raw = String(text ?? '');
  const compact = raw.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length > 20) return false;
  if (!/\d{1,2}:\d{2}/.test(compact)) return false;
  if (/[，。！？；]/.test(raw)) return false;
  return true;
}

/** 很像发送者名：短、无标点、非时间。 */
export function looksLikeSender(text) {
  const t = String(text ?? '').trim();
  if (t.length === 0 || t.length > 12) return false;
  if (isTimeMarker(t)) return false;
  if (/[，。！？；,.!?;]/.test(t)) return false;
  return true;
}

/** 纯 UI 噪点（微信界面固定文案），不该当成聊天内容。 */
const UI_NOISE = new Set([
  '以下为新消息',
  '查看更多消息',
  '对方正在输入',
  '对方正在输入...',
  '消息已发出',
  '已撤回',
  '撤回了一条消息',
  '发送失败，请重试',
  '按住说话',
  '长按说话',
  '聊天信息',
  '通讯录',
  '发现',
]);

export function isUiNoise(text) {
  const t = String(text ?? '').trim();
  if (t.length === 0) return true;
  if (UI_NOISE.has(t)) return true;
  // 纯标点 / 纯符号 / 纯空白
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return true;
  return false;
}

/** 只有日期没有时分（微信里的日期分隔条），不是消息。 */
export function isDateDivider(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  if (t.length === 0) return false;
  if (/\d{1,2}:\d{2}/.test(t)) return false;
  return /^(昨天|前天|今天|星期[一二三四五六日天]|周[一二三四五六日天]|\d{1,2}月\d{1,2}日|20\d{2}年\d{1,2}月\d{1,2}日)$/.test(t);
}

/** 把 HH:MM 补成带日期的完整时间；没有基础日期就原样返回。 */
export function withBaseDate(marker, baseDate) {
  const t = String(marker ?? '').replace(/\s+/g, '');
  if (!baseDate) return t;
  const hm = /(\d{1,2}:\d{2})$/.exec(t);
  if (!hm) return t;
  // 已经带日期（含 年/月/日 或 - / .）就不动
  if (/[年月日]|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}/.test(t)) {
    return t;
  }
  return `${baseDate} ${hm[1].padStart(5, '0')}`;
}

/** 中文之间的换行直接拼接；英文/数字之间补空格。 */
function joinWrapped(left, right) {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const lastChar = left[left.length - 1];
  const firstChar = right[0];
  const cjkEnd = new RegExp(`[${CJK}，。！？、；：（）《》“”‘’…—]`).test(lastChar);
  const cjkStart = new RegExp(`[${CJK}]`).test(firstChar);
  return cjkEnd || cjkStart ? left + right : `${left} ${right}`;
}

/**
 * 气泡里的换行会被 OCR 拆成多行：同一 x、行距很小的相邻正文行合并成一条消息。
 * 不合并的话，一句被折行的话会变成好几条"消息"，既难读也影响摘要质量。
 */
export function mergeWrappedRows(rows, { xTolerance = 8, gapFactor = 0.7 } = {}) {
  const out = [];
  let prev = null;

  for (const row of rows) {
    const bodyLike = !looksLikeSender(row.text) || row.text.length > 12;

    if (
      prev &&
      prev.bodyLike &&
      bodyLike &&
      Math.abs(row.x - prev.row.x) <= xTolerance &&
      row.y >= prev.row.y &&
      row.y - (prev.row.y + prev.row.h) <= Math.max(2, prev.row.h * gapFactor)
    ) {
      prev.row.text = joinWrapped(prev.row.text, row.text);
      prev.row.h = row.y + row.h - prev.row.y;
      continue;
    }

    const entry = { row, bodyLike };
    out.push(entry);
    prev = entry;
  }

  return out.map((entry) => entry.row);
}

/**
 * @param {Array<{text:string,x:number,y:number,w:number,h:number}>} lines
 * @param {{pageWidth?:number, selfSender?:string, defaultTime?:string, baseDate?:string, mergeWrapped?:boolean}} options
 * @returns {{messages: Array<{at:string,sender:string,text:string}>, warnings: string[]}}
 */
export function parseOcrLines(lines, options = {}) {
  const {
    pageWidth = 0,
    selfSender = '我',
    defaultTime = '未知时间',
    baseDate = '',
    mergeWrapped = true,
  } = options;
  const warnings = [];
  const messages = [];

  const normalized = (Array.isArray(lines) ? lines : [])
    .filter((line) => line && typeof line.text === 'string')
    .map((line) => ({
      text: normalizePunct(squeezeCjk(line.text)),
      x: Number(line.x ?? 0),
      y: Number(line.y ?? 0),
      w: Number(line.w ?? 0),
      h: Number(line.h ?? 0),
    }))
    .filter((line) => line.text.length > 0)
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  // 先做换行合并，再做角色判定：否则折行会把一句话拆成几条"消息"
  const rows = mergeWrapped ? mergeWrappedRows(normalized) : normalized;

  let currentTime = defaultTime;
  let pendingSender = null;
  let dropped = 0;
  let noise = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];

    if (isUiNoise(row.text)) {
      noise += 1;
      continue;
    }

    if (isDateDivider(row.text)) {
      // 日期分隔条：只影响时间上下文，不产生消息
      currentTime = withBaseDate(row.text, baseDate);
      pendingSender = null;
      continue;
    }

    if (isTimeMarker(row.text)) {
      // 时间标记只保留"压缩后"的形态：OCR 常把 "2026年11月10日 09:12" 读成
      // "2026 年 1 1 10 日 09:12"，去掉空格至少不再散架。
      // 给了 baseDate 时补成完整日期（OCR 常把日期读残）。
      currentTime = withBaseDate(row.text, baseDate);
      pendingSender = null;
      continue;
    }

    const isRight = pageWidth > 0 && row.x > pageWidth * 0.55;

    // 右侧的 3-4 位纯数字（OCR 把 "10:05" 读成 "1005"）是时间戳噪音，不是消息
    if (isRight && /^\d{3,4}$/.test(row.text)) continue;

    // 短行既可能是发送者名，也可能是一句很短的话。
    // 判据：后面紧跟一行"更长/更像正文"的内容 → 它是发送者；否则它自己就是消息。
    const next = rows[i + 1];
    const followedByBody =
      Boolean(next) &&
      !isTimeMarker(next.text) &&
      !(pageWidth > 0 && next.x > pageWidth * 0.55) &&
      (!looksLikeSender(next.text) || next.text.length > row.text.length);

    if (!isRight && looksLikeSender(row.text) && followedByBody) {
      pendingSender = row.text;
      continue;
    }

    // 极短且明显是 UI 噪音的丢弃
    if (row.text.length <= 1) {
      dropped += 1;
      continue;
    }

    messages.push({
      at: currentTime,
      sender: isRight ? selfSender : pendingSender ?? '未知发送者',
      text: row.text,
    });

    if (!isRight && pendingSender === null) {
      warnings.push(`无法判定发送者的行：${row.text.slice(0, 12)}`);
    }
    pendingSender = null;
  }

  if (pendingSender !== null) {
    warnings.push(`末尾残留疑似发送者名：${pendingSender}`);
  }
  if (dropped > 0) warnings.push(`丢弃 ${dropped} 行单字符噪音`);
  if (noise > 0) warnings.push(`过滤 ${noise} 行界面文案`);

  return { messages, warnings };
}

/** 生成 messages.txt 文本（与 file 适配器的 TEXT_LINE 格式一致）。 */
export function toMessagesText(messages) {
  return (
    (Array.isArray(messages) ? messages : [])
      .map((m) => `[${m.at}] ${m.sender}: ${m.text}`)
      .join('\n') + '\n'
  );
}

/** 内容级去重（同一屏重复截图时避免重复入库）。 */
export function dedupe(messages) {
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const key = `${m.sender}\u0000${m.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}
