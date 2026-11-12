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

/**
 * @param {Array<{text:string,x:number,y:number,w:number,h:number}>} lines
 * @param {{pageWidth?:number, selfSender?:string, defaultTime?:string}} options
 * @returns {{messages: Array<{at:string,sender:string,text:string}>, warnings: string[]}}
 */
export function parseOcrLines(lines, options = {}) {
  const { pageWidth = 0, selfSender = '我', defaultTime = '未知时间' } = options;
  const warnings = [];
  const messages = [];

  const rows = (Array.isArray(lines) ? lines : [])
    .filter((line) => line && typeof line.text === 'string')
    .map((line) => ({
      text: normalizePunct(squeezeCjk(line.text)),
      x: Number(line.x ?? 0),
      y: Number(line.y ?? 0),
      h: Number(line.h ?? 0),
    }))
    .filter((line) => line.text.length > 0)
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  let currentTime = defaultTime;
  let pendingSender = null;
  let dropped = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];

    if (isTimeMarker(row.text)) {
      // 时间标记只保留"压缩后"的形态：OCR 常把 "2026年11月10日 09:12" 读成
      // "2026 年 1 1 10 日 09:12"，去掉空格至少不再散架。
      currentTime = row.text.replace(/\s+/g, '');
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
