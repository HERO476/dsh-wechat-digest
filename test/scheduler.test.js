/**
 * 定时总结的消费者：以前 config.schedule 只被解析存盘，没人执行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dueKey, localParts, createScheduler, SCHEDULE_STATE_FILE } from '../lib/scheduler.mjs';
import { configPath, saveConfig, defaultConfig } from '../src/config.js';

const SHANGHAI_0900 = new Date('2026-11-10T01:00:00Z'); // 周二 09:00 +08:00

function schedule(overrides = {}) {
  return {
    enabled: true,
    kind: 'weekly',
    weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'],
    time: '09:00',
    timeZone: 'Asia/Shanghai',
    ...overrides,
  };
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-digest-sched-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('时区换算：UTC 01:00 = 上海 09:00、周二', () => {
  const parts = localParts(SHANGHAI_0900, 'Asia/Shanghai');
  assert.equal(parts.date, '2026-11-10');
  assert.equal(parts.hour, '09');
  assert.equal(parts.minute, '00');
  assert.equal(parts.weekday, 'TU');
});

test('命中的分钟返回时间片 key', () => {
  assert.equal(dueKey(schedule(), SHANGHAI_0900), '2026-11-10T09:00@Asia/Shanghai');
});

test('未启用 / 时间不符 / 星期不符 / 非法时区 都不触发', () => {
  assert.equal(dueKey(schedule({ enabled: false }), SHANGHAI_0900), null);
  assert.equal(dueKey(schedule({ time: '09:30' }), SHANGHAI_0900), null);
  assert.equal(dueKey(schedule({ weekdays: ['MO'] }), SHANGHAI_0900), null, '周二不在勾选里');
  assert.equal(dueKey(schedule({ timeZone: 'Not/AZone' }), SHANGHAI_0900), null);
  assert.equal(dueKey(null, SHANGHAI_0900), null);
});

test('daily 不看星期', () => {
  assert.ok(dueKey(schedule({ kind: 'daily', weekdays: [] }), SHANGHAI_0900));
});

test('tick 命中时只跑一次，并把时间片记账（同一分钟不重复计费）', async () => {
  await withDir(async (dir) => {
    saveConfig(configPath(dir), defaultConfig()); // 默认就是工作日 09:00

    let runs = 0;
    const scheduler = createScheduler({
      paths: { dataDir: dir, exportDir: join(dir, 'exports') },
      now: () => SHANGHAI_0900,
      run: async (trigger) => {
        runs += 1;
        return { status: 'COMPLETED', trigger };
      },
      log: () => {},
    });

    const first = await scheduler.tick();
    assert.equal(first.status, 'COMPLETED');
    assert.equal(runs, 1);

    const second = await scheduler.tick();
    assert.equal(second, null, '同一分钟不应再触发');
    assert.equal(runs, 1);

    const state = JSON.parse(await readFile(join(dir, SCHEDULE_STATE_FILE), 'utf8'));
    assert.equal(state.lastKey, '2026-11-10T09:00@Asia/Shanghai');
  });
});

test('未命中时不写状态文件、不跑', async () => {
  await withDir(async (dir) => {
    saveConfig(configPath(dir), defaultConfig());

    let runs = 0;
    const scheduler = createScheduler({
      paths: { dataDir: dir, exportDir: join(dir, 'exports') },
      now: () => new Date('2026-11-10T01:05:00Z'), // 09:05
      run: async () => {
        runs += 1;
        return { status: 'COMPLETED' };
      },
      log: () => {},
    });

    assert.equal(await scheduler.tick(), null);
    assert.equal(runs, 0);
    await assert.rejects(readFile(join(dir, SCHEDULE_STATE_FILE), 'utf8'));
  });
});

test('配置里的定时关掉时永远不跑', async () => {
  await withDir(async (dir) => {
    const config = defaultConfig();
    config.schedule = { ...config.schedule, enabled: false };
    saveConfig(configPath(dir), config);

    let runs = 0;
    const scheduler = createScheduler({
      paths: { dataDir: dir, exportDir: join(dir, 'exports') },
      now: () => SHANGHAI_0900,
      run: async () => {
        runs += 1;
        return { status: 'COMPLETED' };
      },
      log: () => {},
    });

    assert.equal(await scheduler.tick(), null);
    assert.equal(runs, 0);
  });
});

test('start/stop 可重复调用（宿主卸载时不能泄漏 interval）', async () => {
  await withDir(async (dir) => {
    const scheduler = createScheduler({
      paths: { dataDir: dir, exportDir: join(dir, 'exports') },
      now: () => SHANGHAI_0900,
      run: async () => ({ status: 'COMPLETED' }),
      log: () => {},
    });

    const stop = scheduler.start();
    assert.equal(scheduler.running, true);
    stop();
    assert.equal(scheduler.running, false);
    stop(); // 幂等
  });
});
