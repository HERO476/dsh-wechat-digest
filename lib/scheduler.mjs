/**
 * 定时总结的消费者。
 *
 * 背景：`config.schedule` 以前只被解析和存盘，全仓没有任何消费者——
 * 用户在设置页把「每周一至五 09:00」打开之后，到点什么都不会发生。
 * 这里补上真正的触发者：每 N 秒检查一次，命中「当天 + 当天星期 + 时分」就跑一次，
 * 并用 `<dataDir>/schedule-state.json` 记最后一次命中的时间片，避免同一分钟重复跑。
 *
 * 注意：它调用的是同一个 postRun（与「立即总结」/MCP 工具同一条路径、同一把文件锁），
 * 所以定时触发不可能绕过策略闸门。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { configPath, loadConfig } from '../src/config.js';
import { postRun } from '../src/settings-api.js';

export const SCHEDULE_STATE_FILE = 'schedule-state.json';

/** 在指定时区把「此刻」拆成日期/时分/星期。 */
export function localParts(now, timeZone = 'Asia/Shanghai') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });

  const parts = {};
  for (const part of fmt.formatToParts(now)) parts[part.type] = part.value;

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parts.hour,
    minute: parts.minute,
    weekday: String(parts.weekday ?? '').toUpperCase().slice(0, 2),
  };
}

/**
 * 这一刻该不该跑？返回命中的时间片 key（同一分钟只会返回一次相同的 key），不命中返回 null。
 */
export function dueKey(schedule, now, defaultTimeZone = 'Asia/Shanghai') {
  if (!schedule || schedule.enabled !== true) return null;
  if (typeof schedule.time !== 'string') return null;

  const timeZone = typeof schedule.timeZone === 'string' && schedule.timeZone.length > 0 ? schedule.timeZone : defaultTimeZone;

  let local;
  try {
    local = localParts(now, timeZone);
  } catch {
    // 非法时区 → 不触发（而不是按本机时区瞎跑）
    return null;
  }

  const [hour, minute] = schedule.time.split(':');
  if (local.hour !== hour || local.minute !== minute) return null;

  if (schedule.kind === 'weekly') {
    const days = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
    if (!days.includes(local.weekday)) return null;
  }

  return `${local.date}T${local.hour}:${local.minute}@${timeZone}`;
}

function readState(dir) {
  const path = join(dir, SCHEDULE_STATE_FILE);
  if (!existsSync(path)) return { path, state: { lastKey: null } };
  try {
    return { path, state: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { path, state: { lastKey: null } };
  }
}

/**
 * @param {{
 *   paths: {dataDir:string, exportDir:string},
 *   env?: object,
 *   now?: () => Date,
 *   intervalMs?: number,
 *   log?: (message:string) => void,
 *   run?: Function,
 * }} options
 */
export function createScheduler(options = {}) {
  const {
    paths,
    env = process.env,
    now = () => new Date(),
    intervalMs = 30_000,
    log = () => {},
    run = (trigger) => postRun(paths, { trigger, env }),
  } = options;

  if (!paths?.dataDir) throw new Error('SCHEDULER_MISSING_DATA_DIR');

  mkdirSync(paths.dataDir, { recursive: true });

  let timer = null;
  let busy = false;
  let lastResult = null;

  async function tick() {
    if (busy) return null;
    busy = true;
    try {
      const { config, error } = loadConfig(configPath(paths.dataDir));
      if (error) log(`定时常量读取配置失败（按全关处理）：${error}`);

      const key = dueKey(config.schedule, now());
      if (key === null) return null;

      const { path, state } = readState(paths.dataDir);
      if (state.lastKey === key) return null;

      // 先记账再跑：宁可漏一次，也不要在同一分钟里重复计费。
      writeFileSync(path, `${JSON.stringify({ lastKey: key, firedAt: new Date().toISOString() })}\n`, 'utf8');
      log(`定时触发：${key}`);

      const result = await run('scheduled');
      lastResult = result;
      log(`定时完成：${result?.status ?? 'UNKNOWN'}`);
      return result;
    } catch (err) {
      log(`定时任务出错：${String(err?.code ?? err?.message ?? err)}`);
      return null;
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return stop;
    // 启动时先对一次表（否则整分钟窗口可能被错过）。
    void tick();
    timer = setInterval(() => void tick(), intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return stop;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    tick,
    start,
    stop,
    get running() {
      return timer !== null;
    },
    get lastResult() {
      return lastResult;
    },
  };
}
