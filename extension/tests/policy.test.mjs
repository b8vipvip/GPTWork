import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_POLICY,
  DEFAULT_SETTINGS,
  normalizePolicy,
  normalizeReasoningLevel,
  normalizeSettings,
} from '../policy.js';

test('uses the canonical default policy', () => {
  assert.deepEqual(normalizePolicy(null), DEFAULT_POLICY);
});

test('migrates legacy extension field names', () => {
  assert.deepEqual(
    normalizePolicy({
      models: ['GPT-5.6-SOL'],
      reasoningLevels: ['xhigh', 'high'],
      strictMode: false,
    }),
    {
      lockedModels: ['gpt-5.6-sol'],
      allowedReasoningLevels: ['extra-high', 'high'],
      strictMode: false,
    },
  );
});

test('rejects malformed custom model identifiers', () => {
  const policy = normalizePolicy({
    lockedModels: ['valid-model', '<script>'],
    allowedReasoningLevels: ['medium'],
    strictMode: true,
  });
  assert.deepEqual(policy.lockedModels, ['valid-model']);
});

test('normalizes extra-high aliases', () => {
  assert.equal(normalizeReasoningLevel('extra_high'), 'extra-high');
  assert.equal(normalizeReasoningLevel('xhigh'), 'extra-high');
});

test('normalizes extension-only verification settings independently', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(
    normalizeSettings({
      enabled: false,
      networkVerificationEnabled: false,
      firstRequestMode: 'block',
      autoAlignSelection: false,
      preferredReasoning: 'xhigh',
      ignored: 'value',
    }),
    {
      enabled: false,
      networkVerificationEnabled: false,
      firstRequestMode: 'block',
      autoAlignSelection: false,
      preferredReasoning: 'extra-high',
    },
  );
});


test('explicit empty locked model list disables model locking', () => {
  assert.deepEqual(normalizePolicy({ lockedModels: [], allowedReasoningLevels: ['high'], strictMode: true }).lockedModels, []);
});
