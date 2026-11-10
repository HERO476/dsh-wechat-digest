import test from 'node:test';
import assert from 'node:assert/strict';

import { checkCorePurity } from '../scripts/check-core-purity.mjs';

test('core 层通过纯净性与零写能力静态检查', async () => {
  const result = await checkCorePurity();
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.ok(result.files.length >= 8, `只扫到 ${result.files.length} 个文件，可能扫描目录不对`);
});
