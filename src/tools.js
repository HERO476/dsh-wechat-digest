/**
 * 工具处理器：把 toolSurface 里声明的三个工具接到真实服务上。
 *
 * 每个 handler 都做一次入参白名单校验——即便宿主已经把 schema 交给模型，
 * 这里仍要再挡一遍：多传一个键就拒绝，绝不"忽略未知参数继续跑"。
 */

import { TOOLS, validateToolSurface } from './core/toolSurface.js';

export function createToolHandlers(service) {
  const surface = validateToolSurface();
  if (!surface.ok) throw new Error(`TOOL_SURFACE_INVALID:${surface.violations.join(',')}`);

  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

  function assertNoExtraKeys(toolName, input) {
    const schema = byName.get(toolName)?.inputSchema ?? {};
    const allowedKeys = new Set(Object.keys(schema.properties ?? {}));
    const extra = Object.keys(input ?? {}).filter((key) => !allowedKeys.has(key));
    if (extra.length > 0) {
      throw Object.assign(new Error(`UNEXPECTED_PARAM:${extra.join(',')}`), { code: 'UNEXPECTED_PARAM' });
    }
  }

  return {
    async list_rooms(input = {}) {
      assertNoExtraKeys('list_rooms', input);
      return service.listRooms();
    },

    async run_summary(input = {}) {
      assertNoExtraKeys('run_summary', input);
      // 工具是用户主动要求总结的入口，因此固定为 manual。
      // 即使模型想传别的也不会被接受，因为 schema 里没有这个参数。
      return service.runSummary({ trigger: 'manual' });
    },

    async get_summary(input = {}) {
      assertNoExtraKeys('get_summary', input);
      return service.getSummary(input.roomHandle);
    },
  };
}
