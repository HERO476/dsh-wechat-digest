/**
 * MCP stdio 协议层（纯函数 + 注入 send）：单独成文件是为了能被测试直接驱动，
 * 不必 spawn 子进程（DSH 沙箱里 spawn 会 EPERM）。
 *
 * 三条与宿主适配有关的约定：
 *  1) initialize 必须回显客户端给的 protocolVersion（若支持），不能写死；
 *  2) tools/list 必须带 annotations —— 宿主/审批层据此判断工具是否有副作用；
 *  3) 工具级失败（status=FAILED/REJECTED）必须 isError:true，否则模型会把失败当成功。
 */

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
export const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const FAILURE_STATUSES = new Set(['FAILED', 'REJECTED']);

/** 工具返回值是否应被视为「调用失败」。 */
export function isFailure(output) {
  return Boolean(output && typeof output === 'object' && FAILURE_STATUSES.has(output.status));
}

function fail(code, message) {
  const err = new Error(message ?? code);
  err.code = code;
  return err;
}

/**
 * @param {{
 *   handlers: Record<string, Function>,
 *   tools: Array<{name:string, description:string, inputSchema:object, annotations?:object}>,
 *   send: (message:object) => void,
 *   serverInfo: {name:string, version:string},
 *   supportedVersions?: readonly string[],
 *   preferredVersion?: string,
 * }} options
 */
export function createProtocol(options = {}) {
  const {
    handlers,
    tools,
    send,
    serverInfo,
    supportedVersions = SUPPORTED_PROTOCOL_VERSIONS,
    preferredVersion = PREFERRED_PROTOCOL_VERSION,
  } = options;

  if (!handlers || typeof handlers !== 'object') throw fail('PROTOCOL_MISSING_HANDLERS');
  if (!Array.isArray(tools)) throw fail('PROTOCOL_MISSING_TOOLS');
  if (typeof send !== 'function') throw fail('PROTOCOL_MISSING_SEND');
  if (!serverInfo?.name || !serverInfo?.version) throw fail('PROTOCOL_MISSING_SERVER_INFO');

  async function handle(request) {
    const { id, method, params } = request ?? {};

    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: supportedVersions.includes(asked) ? asked : preferredVersion,
          capabilities: { tools: {} },
          serverInfo: { name: serverInfo.name, version: serverInfo.version },
        },
      });
    }

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return undefined;

    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });

    if (method === 'tools/list') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          })),
        },
      });
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const handler = handlers[name];
      if (typeof handler !== 'function') {
        return send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'UNKNOWN_TOOL' } }) }], isError: true },
        });
      }
      try {
        const output = await handler(params?.arguments ?? {});
        return send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], isError: isFailure(output) },
        });
      } catch (err) {
        const code = String(err?.code ?? 'TOOL_ERROR');
        return send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify({ error: { code } }) }], isError: true },
        });
      }
    }

    if (id !== undefined) {
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'METHOD_NOT_FOUND' } });
    }
    return undefined;
  }

  /** 处理一行 stdio 文本；不是 JSON 的行静默忽略（stdout 只能出 JSON-RPC 帧）。 */
  async function handleLine(line) {
    const text = typeof line === 'string' ? line.trim() : '';
    if (text.length === 0) return undefined;

    let request;
    try {
      request = JSON.parse(text);
    } catch {
      return undefined;
    }

    try {
      return await handle(request);
    } catch (err) {
      if (request?.id !== undefined) {
        return send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: String(err?.message ?? err) } });
      }
      return undefined;
    }
  }

  return { handle, handleLine };
}
