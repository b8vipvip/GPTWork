import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { toNativePolicy } from '../policy.js';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('v0.5.168 keeps extension-only Work defaults outside the Native Core schema', () => {
  const projected = toNativePolicy({
    lockedModels: ['gpt-6-astra', 'gpt-6-sol'],
    workDefaultModel: 'gpt-6-sol',
    allowedReasoningLevels: ['high', 'extra-high'],
    strictMode: true,
  });

  assert.deepEqual(projected, {
    lockedModels: ['gpt-6-astra', 'gpt-6-sol'],
    allowedReasoningLevels: ['high', 'extra-high'],
    strictMode: true,
  });
  assert.equal(Object.hasOwn(projected, 'workDefaultModel'), false);

  assert.match(background, /sendNative\('set_policy', \{ policy: toNativePolicy\(currentPolicy\) \}\)/);
  assert.match(background, /sendNative\('verify', \{\s*policy: toNativePolicy\(policy\),/);
});
