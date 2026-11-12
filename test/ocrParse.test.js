/**
 * 截图 OCR 解析层测试：用真实 OCR 输出（含中文字间空格）当输入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { squeezeCjk, normalizePunct, isTimeMarker, looksLikeSender, parseOcrLines, toMessagesText, dedupe } from '../src/ocr-parse.mjs';

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
