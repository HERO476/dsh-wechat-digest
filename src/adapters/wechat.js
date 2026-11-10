/**
 * 微信真实取数适配器 —— 骨架。
 *
 * 现状（本机实测结论，见 SPEC.md §7）：
 *  - 微信 4.x 的库是 SQLCipher 变体加密；
 *  - 解密密钥只在 Weixin.exe 进程内存里；
 *  - DSH 工作区带 Low 完整性标签，沙箱内无法读取 Medium IL 进程的内存。
 *
 * 因此本适配器 **不实现任何解密**，也不做任何进程内存读取。
 * 它只做两件事：
 *  1) preflight：只读探测数据布局（目录、文件、加密头），不解密、不读正文；
 *  2) 在密钥能力缺席时 **显式 fail-closed**，给出可诊断的错误码，
 *     绝不"退化成读全部会话"或"退化成抓屏"。
 *
 * 真正的取数能力必须由沙箱外、经用户书面授权的组件注入 keyProvider 后才可用。
 */

import { readdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const ADAPTER_ERROR = Object.freeze({
  DATA_ROOT_MISSING: 'DATA_ROOT_MISSING',
  ACCOUNT_AMBIGUOUS: 'ACCOUNT_AMBIGUOUS',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  KEY_PROVIDER_MISSING: 'KEY_PROVIDER_MISSING',
  DECRYPT_UNAVAILABLE: 'DECRYPT_UNAVAILABLE',
});

const SQLITE_PLAINTEXT_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');

/** 只读文件头 16 字节判断加密，绝不整库读进内存（库有 14 MB 以上）。 */
async function readHeader(path, length = 16) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

function fail(code, message) {
  const err = new Error(message ?? code);
  err.code = code;
  return err;
}

/**
 * @param {{dataRoot:string, account?:string, keyProvider?:Function}} options
 */
export function createWeChatAdapter(options = {}) {
  const { dataRoot, account, keyProvider } = options;

  return {
    name: 'wechat',

    /**
     * 只读体检：列出账号目录、探测消息库是否存在、判断是否加密。
     * 不读正文、不解密。
     */
    async preflight() {
      if (!dataRoot) throw fail(ADAPTER_ERROR.DATA_ROOT_MISSING, '未配置 dataRoot');

      let entries;
      try {
        entries = await readdir(dataRoot, { withFileTypes: true });
      } catch {
        throw fail(ADAPTER_ERROR.DATA_ROOT_MISSING, `数据根不可读: ${dataRoot}`);
      }

      const accounts = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('wxid_'))
        .map((entry) => entry.name);

      if (accounts.length === 0) throw fail(ADAPTER_ERROR.ACCOUNT_NOT_FOUND, '未发现任何 wxid_ 账号目录');
      if (!account && accounts.length > 1) {
        throw fail(ADAPTER_ERROR.ACCOUNT_AMBIGUOUS, `发现 ${accounts.length} 个账号，必须显式绑定其中一个`);
      }
      if (account && !accounts.includes(account)) {
        throw fail(ADAPTER_ERROR.ACCOUNT_NOT_FOUND, `账号目录不存在: ${account}`);
      }

      const bound = account ?? accounts[0];
      const messagePath = join(dataRoot, bound, 'db_storage', 'message', 'message_0.db');

      let encrypted = null;
      let size = null;
      try {
        const info = await stat(messagePath);
        size = info.size;
        const head = await readHeader(messagePath);
        encrypted = !head.equals(SQLITE_PLAINTEXT_MAGIC);
      } catch {
        encrypted = null;
      }

      return Object.freeze({
        dataRoot,
        accounts,
        boundAccount: bound,
        messageDbPath: messagePath,
        messageDbBytes: size,
        looksEncrypted: encrypted,
        canDecrypt: typeof keyProvider === 'function',
      });
    },

    async listRooms() {
      throw fail(
        ADAPTER_ERROR.DECRYPT_UNAVAILABLE,
        '取数能力未接入：需要沙箱外组件提供已解密的会话清单（见 docs/PHASE2.md）',
      );
    },

    async fetchMessages() {
      if (typeof keyProvider !== 'function') {
        throw fail(ADAPTER_ERROR.KEY_PROVIDER_MISSING, '未注入 keyProvider，无法解密消息库');
      }
      throw fail(ADAPTER_ERROR.DECRYPT_UNAVAILABLE, '解密读取尚未实现');
    },
  };
}
