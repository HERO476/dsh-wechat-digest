/**
 * 模型摘要器：把已放行的消息交给 OpenAI 兼容接口，产出结构化要点。
 *
 * 边界（很重要）：
 *  - 只接收闸门放行之后的消息，本模块拿不到也不需要任何会话 id；
 *  - 不做"失败了就退回关键词规则"的静默降级——失败就显式报错，让调用方看见；
 *  - 不联网到任何非配置地址（baseUrl 唯一来源是配置）。
 */

const DEFAULT_MAX_CHARS = 12000;

export class SummarizeError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

export function buildChatMessages({ messages, maxChars = DEFAULT_MAX_CHARS }) {
  const lines = [];
  let used = 0;
  let truncated = false;

  for (const message of messages) {
    const line = `${message.at ?? ''} ${message.sender ?? '?'}: ${message.text ?? ''}`.trim();
    if (used + line.length > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length;
  }

  const system = [
    '你是会议与任务助理。阅读下面的群聊记录，抽取三类信息：重点活动、任务/待办、被 @ 的人。',
    '只输出一个 JSON 对象，形如 {"tasks":[],"activities":[],"mentions":[]}。',
    '每项是一条不超过 40 字的中文短句；只写记录里确实存在的内容，没有就返回空数组。',
    '不要输出 JSON 之外的任何文字。',
  ].join('\n');

  const user = lines.length === 0 ? '（窗口内没有消息）' : lines.join('\n');

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    included: lines.length,
    truncated,
  };
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
}

function tryParseJson(text) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param {{baseUrl:string, apiKey?:string, model:string, headers?:object, timeoutMs?:number, fetchImpl?:Function, maxChars?:number}} config
 */
export function createLlmSummarizer(config = {}) {
  const {
    baseUrl,
    apiKey,
    model,
    headers: extraHeaders = {},
    timeoutMs = 30000,
    fetchImpl = globalThis.fetch,
    maxChars = DEFAULT_MAX_CHARS,
  } = config;

  if (!baseUrl || !model) throw new SummarizeError('LLM_CONFIG_MISSING', '需要 baseUrl 与 model');
  if (typeof fetchImpl !== 'function') throw new SummarizeError('LLM_FETCH_UNAVAILABLE');

  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  return async function summarize({ messages }) {
    const built = buildChatMessages({ messages, maxChars });

    // provider 自带的头（如 OpenCode Go 的 x-opencode-session）优先铺底，再加鉴权
    const headers = { ...extraHeaders, 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: built.messages, temperature: 0.2 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SummarizeError('SUMMARIZE_NETWORK_FAILED', String(err?.message ?? err));
    }

    if (!response.ok) {
      throw new SummarizeError(`SUMMARIZE_HTTP_${response.status}`, `模型接口返回 ${response.status}`);
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw new SummarizeError('SUMMARIZE_BAD_RESPONSE', String(err?.message ?? err));
    }

    const text = data?.choices?.[0]?.message?.content ?? '';
    const parsed = tryParseJson(text);

    return {
      tasks: toStringArray(parsed?.tasks),
      activities: toStringArray(parsed?.activities),
      mentions: toStringArray(parsed?.mentions),
      // 模型没按 JSON 回，就把原文留着，至少不丢信息（渲染时会走 narrative 分支）
      narrative: parsed ? null : String(text).trim() || null,
      total: messages.length,
      truncated: built.truncated,
      seqFrom: messages[0]?.seq ?? 0,
      seqTo: messages[messages.length - 1]?.seq ?? 0,
      model,
    };
  };
}
