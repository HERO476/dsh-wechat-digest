import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, validateToolSurface, FORBIDDEN_TOOL_NAME } from '../src/core/toolSurface.js';

test('发布出去的工具面本身合规', () => {
  const result = validateToolSurface();
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test('不存在任何发送类工具', () => {
  for (const tool of TOOLS) {
    assert.equal(FORBIDDEN_TOOL_NAME.test(tool.name), false, tool.name);
  }
});

test('run_summary 只有一个不存在的范围参数——即不接受任何参数', () => {
  const tool = TOOLS.find((item) => item.name === 'run_summary');
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), []);
  assert.equal(tool.inputSchema.additionalProperties, false);
});

test('唯一的外部参数是不透明句柄', () => {
  const params = TOOLS.flatMap((tool) => Object.keys(tool.inputSchema.properties ?? {}));
  assert.deepEqual(params, ['roomHandle']);
});

test('注入发送工具或原始 chat id 参数会被校验拦下', () => {
  const bad = [
    { name: 'send_message', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    {
      name: 'run_summary',
      inputSchema: {
        type: 'object',
        properties: { chatId: { type: 'string' } },
        additionalProperties: false,
      },
    },
    {
      name: 'get_summary',
      inputSchema: { type: 'object', properties: { roomHandle: { type: 'string' } } },
    },
  ];

  const result = validateToolSurface(bad);
  assert.equal(result.ok, false);
  assert.ok(result.violations.length >= 3, JSON.stringify(result.violations));
  assert.ok(result.violations.some((item) => item.startsWith('FORBIDDEN_TOOL_NAME')));
  assert.ok(result.violations.some((item) => item.startsWith('FORBIDDEN_PARAM')));
  assert.ok(result.violations.some((item) => item.startsWith('OPEN_SCHEMA')));
});

test('每个工具都声明 readOnlyHint，且与文案一致', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.annotations, `${tool.name} 缺 annotations`);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    assert.equal(
      tool.annotations.readOnlyHint,
      tool.description.includes('只读'),
      `${tool.name} 文案与 readOnlyHint 必须一致`,
    );
  }
});

test('run_summary 不得自称只读（它会写盘并调用模型）', () => {
  const tool = TOOLS.find((item) => item.name === 'run_summary');
  assert.equal(tool.description.includes('只读'), false);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.openWorldHint, true);
  assert.match(tool.description, /模型|费用|写/);
});

test('文案说只读但注解说可写 → 校验拦下', () => {
  const lying = [
    {
      name: 'run_summary',
      description: '立即执行一次总结。只读。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
    },
  ];
  const result = validateToolSurface(lying);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.startsWith('READONLY_CLAIM_CONFLICT')));
});

test('没有 annotations 的工具会被校验拦下', () => {
  const plain = [
    {
      name: 'list_rooms',
      description: '只读：列出可读群聊。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
  const result = validateToolSurface(plain);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.startsWith('ANNOTATIONS_MISSING_READONLY')));
});
