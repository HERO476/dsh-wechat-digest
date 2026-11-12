/**
 * 截图 OCR 解析层测试：用真实 OCR 输出（含中文字间空格）当输入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { squeezeCjk, normalizePunct, isTimeMarker, looksLikeSender, parseOcrLines, toMessagesText, dedupe, withBaseDate, mergeWrappedRows, isUiNoise, isDateDivider } from '../src/ocr-parse.mjs';

test('去掉 OCR 在中文字之间插入的空格', () => {
  assert.equal(squeezeCjk('周 五 前 把 评 审 稿 交 上 来 ， 数 据 口 径'), '周五前把评审稿交上来，数据口径');
  assert.equal(squeezeCjk('待 办 ： 确 认 服 务 器 预 算'), '待办：确认服务器预算');
  // 英文/数字之间的空格要保留
  assert.equal(squeezeCjk('model deepseek flash'), 'model deepseek flash');
});

test('全角冒号与全角数字归一', () => {
  assert.equal(normalizePunct('待办：确认'), '待办:确认');
  assert.equal(normalizePunct('０９：１２'), '09:12');
});

test('时间标记识别', () => {
  for (const t of ['09:12', '昨天 09:12', '2026年11月10日 09:12', '11月10日 下午9:05', '周三 09:12']) {
    assert.equal(isTimeMarker(t), true, t);
  }
  for (const t of ['周五前把评审稿交上来', '9', '待办:确认服务器预算', '小王']) {
    assert.equal(isTimeMarker(t), false, t);
  }
});

test('发送者名判定：短、无标点、非时间', () => {
  assert.equal(looksLikeSender('小王'), true);
  assert.equal(looksLikeSender('老李'), true);
  assert.equal(looksLikeSender('待办:确认服务器预算，截止周三'), false);
  assert.equal(looksLikeSender('09:12'), false);
  assert.equal(looksLikeSender('这是一个超过十二个字的很长的一句话'), false);
});

test('把 OCR 行拼成 [时间] 发送者: 内容', () => {
  const lines = [
    { text: '2026 年 1 1 10 日 09 ： 12', x: 340, y: 20, w: 220, h: 18 },
    { text: '小 王', x: 40, y: 70, w: 30, h: 18 },
    { text: '周 五 前 把 评 审 稿 交 上 来 ， 数 据 口 径 按 上 周 定 的 来 。', x: 40, y: 100, w: 520, h: 24 },
    { text: '老 李', x: 40, y: 170, w: 30, h: 18 },
    { text: '待 办 ： 确 认 服 务 器 预 算 ， 截 止 周 三', x: 40, y: 200, w: 460, h: 24 },
  ];

  const { messages } = parseOcrLines(lines, { pageWidth: 900 });
  assert.equal(messages.length, 2, JSON.stringify(messages));
  assert.equal(messages[0].sender, '小王');
  assert.equal(messages[0].text, '周五前把评审稿交上来，数据口径按上周定的来。');
  assert.equal(messages[1].sender, '老李');
  assert.equal(messages[1].text, '待办:确认服务器预算，截止周三');
});

test('右侧消息判为我发的', () => {
  const lines = [
    { text: '09:12', x: 400, y: 10, w: 40, h: 16 },
    { text: '收 到 ， 我 下 午 对 齐 一 下 。', x: 620, y: 60, w: 240, h: 24 },
  ];
  const { messages } = parseOcrLines(lines, { pageWidth: 900, selfSender: '我' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sender, '我');
});

test('没有时间标记时用默认时间占位', () => {
  const { messages } = parseOcrLines([{ text: '一 句 话', x: 10, y: 10, w: 60, h: 20 }], { pageWidth: 900 });
  assert.equal(messages[0].at, '未知时间');
});

test('messages.txt 文本符合 file 适配器的行格式', () => {
  const text = toMessagesText([
    { at: '09:12', sender: '小王', text: '周五前交评审稿' },
    { at: '09:13', sender: '我', text: '收到' },
  ]);
  assert.equal(text, '[09:12] 小王: 周五前交评审稿\n[09:13] 我: 收到\n');

  const lines = text.trim().split('\n');
  for (const line of lines) {
    assert.match(line, /^\[[^\]]+\]\s*[^:：]+\s*[:：]\s*.+$/);
  }
});

test('重复截图去重（同一句话只留一条）', () => {
  const rows = dedupe([
    { at: '09:12', sender: '小王', text: '周五前交评审稿' },
    { at: '09:12', sender: '小王', text: '周五前交评审稿' },
    { at: '09:13', sender: '老李', text: '收到' },
  ]);
  assert.equal(rows.length, 2);
});

test('空输入不炸', () => {
  const { messages, warnings } = parseOcrLines([]);
  assert.deepEqual(messages, []);
  assert.deepEqual(warnings, []);
});

test('日期补全：只有 HH:MM 时用 --date 补成完整日期', () => {
  assert.equal(withBaseDate('09:12', '2026-11-12'), '2026-11-12 09:12');
  // 单位数小时会补零，保证排序/展示一致
  assert.equal(withBaseDate('昨天9:05', '2026-11-12'), '2026-11-12 09:05');
  // 已经带日期（哪怕是 OCR 读残的）就不动
  assert.equal(withBaseDate('2026年1110日09:12', '2026-11-12'), '2026年1110日09:12');
  assert.equal(withBaseDate('11月10日09:12', '2026-11-12'), '11月10日09:12');
  // 没给基础日期就原样
  assert.equal(withBaseDate('09:12', ''), '09:12');
});

test('气泡折行被合并成一条消息（不再拆成多条）', () => {
  // 同一句被排成两行：x 相同、行距很小
  const lines = [
    { text: '小 王', x: 40, y: 70, w: 30, h: 18 },
    { text: '周五前把评审稿交上来，', x: 40, y: 100, w: 260, h: 24 },
    { text: '数据口径按上周定的来。', x: 40, y: 128, w: 240, h: 24 },
  ];
  const { messages } = parseOcrLines(lines, { pageWidth: 900 });
  assert.equal(messages.length, 1, JSON.stringify(messages));
  assert.equal(messages[0].text, '周五前把评审稿交上来，数据口径按上周定的来。');
});

test('行距很大的两段不合并（是两条消息）', () => {
  const lines = [
    { text: '第一句话在这里', x: 40, y: 100, w: 160, h: 24 },
    { text: '第二句话在下面', x: 40, y: 200, w: 160, h: 24 },
  ];
  const { messages } = parseOcrLines(lines, { pageWidth: 900 });
  assert.equal(messages.length, 2);
});

test('mergeWrappedRows 对英文补空格、对中文直接拼接', () => {
  // 英文折行：两行都够长，不会被误判成"人名"
  const rows = mergeWrappedRows([
    { text: 'this is a long sentence that wraps', x: 10, y: 10, w: 300, h: 20 },
    { text: 'onto the second line', x: 10, y: 32, w: 200, h: 20 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'this is a long sentence that wraps onto the second line');

  const cjk = mergeWrappedRows([
    { text: '周五前把评审稿交上来，', x: 10, y: 10, w: 160, h: 20 },
    { text: '数据口径按上周定的来。', x: 10, y: 32, w: 160, h: 20 },
  ]);
  assert.equal(cjk.length, 1);
  assert.equal(cjk[0].text, '周五前把评审稿交上来，数据口径按上周定的来。');
});

test('--date 生效时消息时间带上完整日期', () => {
  const lines = [
    { text: '09:12', x: 400, y: 10, w: 40, h: 16 },
    { text: '小 王', x: 40, y: 40, w: 30, h: 18 },
    { text: '周五前把评审稿交上来，数据口径按上周定的来。', x: 40, y: 70, w: 420, h: 24 },
  ];
  const { messages } = parseOcrLines(lines, { pageWidth: 900, baseDate: '2026-11-12' });
  assert.equal(messages[0].at, '2026-11-12 09:12');
});

test('界面固定文案与纯符号被过滤掉', () => {
  for (const t of ['以下为新消息', '查看更多消息', '对方正在输入', '消息已发出', '撤回了一条消息', '···', '——']) {
    assert.equal(isUiNoise(t), true, t);
  }
  for (const t of ['周五前交评审稿', '收到', '待办：确认预算']) {
    assert.equal(isUiNoise(t), false, t);
  }
});

test('只有日期的分隔条不算消息，但会更新时间上下文', () => {
  assert.equal(isDateDivider('11月12日'), true);
  assert.equal(isDateDivider('昨天'), true);
  assert.equal(isDateDivider('周三'), true);
  assert.equal(isDateDivider('09:12'), false, '带时分的是时间标记，不是日期条');

  const lines = [
    { text: '11月12日', x: 380, y: 10, w: 80, h: 18 },
    { text: '09:12', x: 380, y: 40, w: 60, h: 18 },
    { text: '小 王', x: 40, y: 70, w: 30, h: 18 },
    { text: '周五前把评审稿交上来，数据口径按上周定的来。', x: 40, y: 100, w: 420, h: 24 },
  ];
  const { messages } = parseOcrLines(lines, { pageWidth: 900 });
  assert.equal(messages.length, 1, JSON.stringify(messages));
  assert.equal(messages[0].sender, '小王');
});

test('纯界面噪音不会变成"消息"', () => {
  const lines = [
    { text: '以下为新消息', x: 300, y: 10, w: 120, h: 16 },
    { text: '09:12', x: 400, y: 40, w: 40, h: 16 },
    { text: '小 王', x: 40, y: 70, w: 30, h: 18 },
    { text: '周五前把评审稿交上来，数据口径按上周定的来。', x: 40, y: 100, w: 420, h: 24 },
  ];
  const { messages, warnings } = parseOcrLines(lines, { pageWidth: 900 });
  assert.equal(messages.length, 1);
  assert.ok(warnings.some((w) => w.includes('界面文案')), JSON.stringify(warnings));
});
