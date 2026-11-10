/**
 * 工具面即策略：接口形状决定能力边界。
 *
 *  - 不存在发送类工具。发送能力在代码里就不存在，不是靠开关关掉。
 *  - 不存在任何接收原始 chat id 的入参。读取用不透明句柄；
 *    范围只能通过策略开关改变，不能通过一次调用改变。
 *  - 所有 schema 都 additionalProperties:false，防止「多塞一个参数」被接受。
 */

export const FORBIDDEN_TOOL_NAME =
  /send|reply|post|forward|comment|broadcast|poke|invite|kick|mute|add_member|write/i;

export const FORBIDDEN_PARAM_NAMES = new Set([
  'key',
  'chatid',
  'chat_id',
  'chatroomid',
  'chatroom_id',
  'wxid',
  'roomid',
  'room_id',
  'conversationid',
  'conversation_id',
  'scope',
  'target',
  'to',
  'receiver',
  'peer',
  'username',
  'talker',
  'trigger',
]);

export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'list_rooms',
    description: '只读取本地导出目录，列出当前策略下可读的群聊（不发送任何消息、不写盘）。',
    inputSchema: Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
    annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  }),
  Object.freeze({
    name: 'run_summary',
    description:
      '执行一次总结：读取被放行的会话消息，调用所配置的模型服务（会出网、会产生调用费用），并把摘要写入本地文件。不接受范围参数，范围由策略开关决定。',
    inputSchema: Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    }),
  }),
  Object.freeze({
    name: 'get_summary',
    description: '只读本地摘要文件：按不透明句柄读取已生成的摘要与溯源定位，并按当前策略复核可见性。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        roomHandle: Object.freeze({ type: 'string', pattern: '^[0-9a-f]{16}$' }),
      }),
      required: Object.freeze(['roomHandle']),
      additionalProperties: false,
    }),
    annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  }),
]);

export function validateToolSurface(tools = TOOLS) {
  const violations = [];

  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) {
      violations.push('TOOL_NAME_MISSING');
      continue;
    }
    if (FORBIDDEN_TOOL_NAME.test(tool.name)) violations.push(`FORBIDDEN_TOOL_NAME:${tool.name}`);

    const schema = tool.inputSchema ?? {};
    if (schema.type !== 'object') violations.push(`SCHEMA_NOT_OBJECT:${tool.name}`);
    if (schema.additionalProperties !== false) violations.push(`OPEN_SCHEMA:${tool.name}`);

    // 只读语义必须显式声明（MCP annotations），且不能与文案互相矛盾。
    const annotations = tool.annotations ?? {};
    if (typeof annotations.readOnlyHint !== 'boolean') {
      violations.push(`ANNOTATIONS_MISSING_READONLY:${tool.name}`);
    }
    const claimsReadOnly = typeof tool.description === 'string' && tool.description.includes('只读');
    if (claimsReadOnly && annotations.readOnlyHint !== true) {
      violations.push(`READONLY_CLAIM_CONFLICT:${tool.name}`);
    }
    if (!claimsReadOnly && annotations.readOnlyHint === true) {
      violations.push(`READONLY_UNDECLARED_IN_TEXT:${tool.name}`);
    }

    for (const prop of Object.keys(schema.properties ?? {})) {
      const lower = prop.toLowerCase();
      const isOpaqueHandle = /handle$/.test(lower);
      if (!isOpaqueHandle && FORBIDDEN_PARAM_NAMES.has(lower)) {
        violations.push(`FORBIDDEN_PARAM:${tool.name}.${prop}`);
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
