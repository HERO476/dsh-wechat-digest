/**
 * 摘要器：本地启发式实现，**不联网、不调模型**。
 *
 * 说明：这只是让链路端到端跑通的占位实现。真正的摘要把 messages 交给模型，
 * 但要遵守两条：只喂闸门放行后的消息；摘要里不得回写原始 chat id。
 */

const TASK_HINTS = ['待办', '任务', '截止', 'deadline', 'TODO', 'todo', '前把', '要做', '记得', '安排'];
const ACTIVITY_HINTS = ['开会', '评审', '上线', '发布', '对齐', '同步', '培训', '活动', '聚餐', '面试'];
const MENTION_HINTS = ['@'];

function hit(text, hints) {
  return hints.some((hint) => text.includes(hint));
}

/**
 * @param {{messages: Array<{seq:number, at?:string, sender?:string, text:string}>}} input
 * @returns {{tasks:string[], activities:string[], mentions:string[], total:number, seqFrom:number, seqTo:number}}
 */
export function summarizeMessages({ messages }) {
  const tasks = [];
  const activities = [];
  const mentions = [];

  for (const message of messages) {
    const text = String(message.text ?? '');
    const who = message.sender ? `${message.sender}: ` : '';
    if (hit(text, TASK_HINTS)) tasks.push(`${who}${text}`);
    if (hit(text, ACTIVITY_HINTS)) activities.push(`${who}${text}`);
    if (hit(text, MENTION_HINTS)) mentions.push(`${who}${text}`);
  }

  return {
    tasks,
    activities,
    mentions,
    total: messages.length,
    seqFrom: messages[0]?.seq ?? 0,
    seqTo: messages[messages.length - 1]?.seq ?? 0,
  };
}

export function renderDigest(digest) {
  const lines = [`覆盖 ${digest.total} 条消息（seq ${digest.seqFrom}–${digest.seqTo}）`];

  if (digest.truncated) lines.push('⚠ 记录过长，已截断送入模型，结论只代表截断后的部分');
  if (digest.model) lines.push(`模型：${digest.model}`);

  if (digest.narrative) {
    lines.push('', String(digest.narrative).trim());
    return lines.join('\n');
  }

  const section = (title, items) => {
    if (!items || items.length === 0) return;
    lines.push('', `## ${title}`);
    for (const item of items) lines.push(`- ${item}`);
  };
  section('任务 / 待办', digest.tasks);
  section('重点活动', digest.activities);
  section('@ 提及', digest.mentions);

  const empty =
    (digest.tasks?.length ?? 0) + (digest.activities?.length ?? 0) + (digest.mentions?.length ?? 0) === 0;
  if (empty) lines.push('', '（本窗口未识别出任务或重点活动）');

  return lines.join('\n');
}
