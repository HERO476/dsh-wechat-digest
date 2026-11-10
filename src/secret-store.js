/**
 * 句柄 HMAC 密钥的来源：环境变量优先，其次是数据目录里持久化的随机密钥。
 *
 * 为什么不再有默认常量：
 *  句柄是「原始会话 id 不对外」的唯一屏障。密钥一旦是仓库里的公开字符串，
 *  任何知道 canonicalId 的人都能自己算出句柄、直接读摘要——句柄就不再是不透明句柄。
 *
 * 两半（宿主进程 / MCP 子进程）必须拿到**同一个**密钥，否则同一个群算出不同句柄。
 * 因此密钥落在两侧共用的数据目录里（`<dataDir>/secret`），首次启动生成，
 * 权限 0600，只写不打印。
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MIN_SECRET_LENGTH = 16;
export const SECRET_FILE_NAME = 'secret';

export function defaultDataDir(env = process.env) {
  return env.WECHAT_DIGEST_DATA_DIR ?? join(homedir(), '.dsh', 'wechat-digest');
}

export function secretPath(dataDir) {
  return join(dataDir, SECRET_FILE_NAME);
}

function fail(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function readSecretFile(path) {
  const value = readFileSync(path, 'utf8').trim();
  if (value.length < MIN_SECRET_LENGTH) throw fail('SECRET_FILE_CORRUPT', { path });
  return value;
}

function tighten(path) {
  // Windows 上 chmod 只影响只读位；失败不影响可用性，但不能因此中断启动。
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

let cached = null;

/**
 * @returns {{secret: string, source: 'env'|'file'|'generated', path: string|null}}
 */
export function resolveSecret({ env = process.env, dataDir } = {}) {
  const fromEnv = env.WECHAT_DIGEST_SECRET;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    const secret = fromEnv.trim();
    if (secret.length < MIN_SECRET_LENGTH) {
      throw fail('SECRET_TOO_SHORT', { minLength: MIN_SECRET_LENGTH });
    }
    return { secret, source: 'env', path: null };
  }

  const dir = dataDir ?? defaultDataDir(env);
  const path = secretPath(dir);
  if (cached && cached.path === path) return { secret: cached.secret, source: 'file', path };

  mkdirSync(dir, { recursive: true });

  if (existsSync(path)) {
    const secret = readSecretFile(path);
    tighten(path);
    cached = { path, secret };
    return { secret, source: 'file', path };
  }

  const secret = randomBytes(32).toString('hex');
  try {
    // 'wx' = 不存在才创建：两个进程同时首次启动时只有一个能写，另一个走 EEXIST 分支重读。
    writeFileSync(path, `${secret}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    tighten(path);
    cached = { path, secret };
    return { secret, source: 'generated', path };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw fail('SECRET_CREATE_FAILED', { path, cause: String(err?.message ?? err) });
    const existing = readSecretFile(path);
    tighten(path);
    cached = { path, secret: existing };
    return { secret: existing, source: 'file', path };
  }
}

/** 只看密钥来源，不返回值。用于启动日志。 */
export function describeSecret(resolved) {
  if (!resolved) return 'none';
  if (resolved.source === 'env') return 'env:WECHAT_DIGEST_SECRET';
  if (resolved.source === 'generated') return `generated:${resolved.path}`;
  return `file:${resolved.path}`;
}

/** 测试用：清掉进程内缓存。 */
export function clearSecretCache() {
  cached = null;
}

/** 测试用：文件权限位（Windows 上可能恒为 0o666，断言时请容忍）。 */
export function secretFileMode(path) {
  return statSync(path).mode & 0o777;
}
