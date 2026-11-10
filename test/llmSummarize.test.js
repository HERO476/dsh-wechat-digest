import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { buildChatMessages, createLlmSummarizer, SummarizeError } from '../src/summarize-llm.js';
import { renderDigest } from '../src/summarize.js';

const MESSAGES = [
  { seq: 1, at: '2026-11-10 09:12', sender: '小王', text: '周五前把评审稿交上来' },
  { seq: 2, at: '2026-11-10 09:15', sender: '老李', text: '待办：确认服务器预算' },
];

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

test('提示词里包含消息正文，且不包含任何会话 id', () => {
  const built = buildChatMessages({ messages: MESSAGES });
  const joined = built.messages.map((message) => message.content).join('\n');
  assert.ok(joined.includes('周五前把评审稿交上来'));
  assert.ok(joined.includes('老李'));
  assert.equal(joined.includes('@chatroom'), false);
  assert.equal(joined.includes('wxid_'), false);
  assert.equal(built.included, 2);
  assert.equal(built.truncated, false);
});

test('超预算时截断并标记', () => {
  const built = buildChatMessages({ messages: MESSAGES, maxChars: 10 });
  assert.equal(built.included, 0);
  assert.equal(built.truncated, true);
});

test('模型返回合法 JSON → 结构化要点', async () => {
  const payload = JSON.stringify({ tasks: ['周五交评审稿'], activities: ['下午三点对齐'], mentions: ['小王'] });

  await withServer(
    async (req, res) => {
      await readBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: payload } }] }));
    },
    async (baseUrl) => {
      const summarize = createLlmSummarizer({ baseUrl, model: 'test-model' });
      const digest = await summarize({ messages: MESSAGES });
      assert.deepEqual(digest.tasks, ['周五交评审稿']);
      assert.deepEqual(digest.activities, ['下午三点对齐']);
      assert.deepEqual(digest.mentions, ['小王']);
      assert.equal(digest.narrative, null);
      assert.equal(digest.seqFrom, 1);
      assert.equal(digest.seqTo, 2);

      const rendered = renderDigest(digest);
      assert.ok(rendered.includes('周五交评审稿'));
      assert.ok(rendered.includes('test-model'));
    },
  );
});

test('请求体带 model 与正确端点', async () => {
  let seenPath = null;
  let seenBody = null;

  await withServer(
    async (req, res) => {
      seenPath = req.url;
      seenBody = JSON.parse(await readBody(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"tasks":[]}' } }] }));
    },
    async (baseUrl) => {
      const summarize = createLlmSummarizer({ baseUrl, model: 'm-1', apiKey: 'k-1' });
      await summarize({ messages: MESSAGES });
      assert.equal(seenPath, '/chat/completions');
      assert.equal(seenBody.model, 'm-1');
      assert.equal(seenBody.messages.length, 2);
    },
  );
});

test('模型不按 JSON 回 → 原文进 narrative，不丢信息', async () => {
  await withServer(
    async (req, res) => {
      await readBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '这周要交评审稿，老李负责预算。' } }] }));
    },
    async (baseUrl) => {
      const summarize = createLlmSummarizer({ baseUrl, model: 'm' });
      const digest = await summarize({ messages: MESSAGES });
      assert.equal(digest.narrative, '这周要交评审稿，老李负责预算。');
      assert.ok(renderDigest(digest).includes('老李负责预算'));
    },
  );
});

test('接口报错 → 显式失败码，不静默降级', async () => {
  await withServer(
    async (req, res) => {
      await readBody(req);
      res.writeHead(500);
      res.end('boom');
    },
    async (baseUrl) => {
      const summarize = createLlmSummarizer({ baseUrl, model: 'm' });
      await assert.rejects(
        () => summarize({ messages: MESSAGES }),
        (err) => err instanceof SummarizeError && err.code === 'SUMMARIZE_HTTP_500',
      );
    },
  );
});

test('网络不可达 → SUMMARIZE_NETWORK_FAILED', async () => {
  const summarize = createLlmSummarizer({ baseUrl: 'http://127.0.0.1:1', model: 'm', timeoutMs: 2000 });
  await assert.rejects(
    () => summarize({ messages: MESSAGES }),
    (err) => err.code === 'SUMMARIZE_NETWORK_FAILED',
  );
});

test('配置缺失直接拒绝构造', () => {
  const isConfigError = (err) => err instanceof SummarizeError && err.code === 'LLM_CONFIG_MISSING';
  assert.throws(() => createLlmSummarizer({ model: 'm' }), isConfigError);
  assert.throws(() => createLlmSummarizer({ baseUrl: 'http://x' }), isConfigError);
});
