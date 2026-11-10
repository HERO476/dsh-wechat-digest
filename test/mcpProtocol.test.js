/**
 * MCP 协议层契约测试：直接驱动纯函数协议层，不 spawn 子进程。
 *
 * 覆盖：版本协商、annotations、isError 语义、未知工具、未知方法、坏 JSON。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createProtocol, isFailure, PREFERRED_PROTOCOL_VERSION } from '../src/mcp-protocol.js';
import { TOOLS } from '../src/core/toolSurface.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function harness(handlers = {}) {
  const frames = [];
  const protocol = createProtocol({
    handlers,
    tools: TOOLS,
    send: (message) => frames.push(message),
    serverInfo: { name: PACKAGE.name, version: PACKAGE.version },
  });
  return { frames, protocol };
}

test('initialize 回显客户端支持的协议版本', async () => {
  const { frames, protocol } = harness();
  await protocol.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(frames[0].result.protocolVersion, '2024-11-05');
});

test('initialize 遇到不支持的版本回自己的首选版本，并报告 package.json 里的版本', async () => {
  const { frames, protocol } = harness();
  await protocol.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(frames[0].result.protocolVersion, PREFERRED_PROTOCOL_VERSION);
  assert.equal(frames[0].result.serverInfo.version, PACKAGE.version, '不能写死 0.1.0');
  assert.equal(frames[0].result.serverInfo.name, PACKAGE.name);
});

test('tools/list 三个工具都带 annotations，且与「只读」文案一致', async () => {
  const { frames, protocol } = harness();
  await protocol.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  const tools = frames[0].result.tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['list_rooms', 'run_summary', 'get_summary'],
  );

  for (const tool of tools) {
    assert.ok(tool.annotations, `${tool.name} 缺 annotations`);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    assert.equal(tool.annotations.readOnlyHint, tool.description.includes('只读'), `${tool.name} 文案与注解矛盾`);
  }

  const run = tools.find((tool) => tool.name === 'run_summary');
  assert.equal(run.annotations.readOnlyHint, false, 'run_summary 会写盘 + 出网，不能标只读');
  assert.equal(run.annotations.openWorldHint, true);

  const list = tools.find((tool) => tool.name === 'list_rooms');
  assert.equal(list.annotations.readOnlyHint, true);
});

test('ping 有响应（宿主健康检查不会把工具判为掉线）', async () => {
  const { frames, protocol } = harness();
  await protocol.handle({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(frames[0], { jsonrpc: '2.0', id: 3, result: {} });
});

test('tools/call 成功时 isError=false', async () => {
  const { frames, protocol } = harness({ list_rooms: async () => ({ allowed: [], denied: [] }) });
  await protocol.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_rooms', arguments: {} } });
  assert.equal(frames[0].result.isError, false);
  assert.deepEqual(JSON.parse(frames[0].result.content[0].text), { allowed: [], denied: [] });
});

test('工具返回 FAILED / REJECTED 时 isError=true（不能把失败当成功）', async () => {
  assert.equal(isFailure({ status: 'FAILED' }), true);
  assert.equal(isFailure({ status: 'REJECTED' }), true);
  assert.equal(isFailure({ status: 'COMPLETED' }), false);
  assert.equal(isFailure({ status: 'NOT_FOUND' }), false, 'NOT_FOUND 是合法空结果，不是错误');
  assert.equal(isFailure({ allowed: [] }), false);

  const { frames, protocol } = harness({ run_summary: async () => ({ status: 'FAILED', code: 'BOOM' }) });
  await protocol.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_summary', arguments: {} } });
  assert.equal(frames[0].result.isError, true);
});

test('未知工具与工具异常都返回结构化错误码 + isError', async () => {
  const { frames, protocol } = harness({
    get_summary: async () => {
      throw Object.assign(new Error('nope'), { code: 'UNEXPECTED_PARAM:foo' });
    },
  });

  await protocol.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'send_message', arguments: {} } });
  assert.equal(frames[0].result.isError, true);
  assert.equal(JSON.parse(frames[0].result.content[0].text).error.code, 'UNKNOWN_TOOL');

  await protocol.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_summary', arguments: {} } });
  assert.equal(frames[1].result.isError, true);
  assert.equal(JSON.parse(frames[1].result.content[0].text).error.code, 'UNEXPECTED_PARAM:foo');
});

test('未知方法回 -32601；坏 JSON 行静默忽略', async () => {
  const { frames, protocol } = harness();
  await protocol.handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
  assert.equal(frames[0].error.code, -32601);

  const before = frames.length;
  await protocol.handleLine('{ not json');
  await protocol.handleLine('   ');
  assert.equal(frames.length, before, '非 JSON 行不应该往 stdout 写任何东西');
});

test('通知类方法不产生响应帧', async () => {
  const { frames, protocol } = harness();
  await protocol.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await protocol.handle({ jsonrpc: '2.0', method: 'notifications/cancelled' });
  assert.equal(frames.length, 0);
});
