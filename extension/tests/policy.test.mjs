import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_POLICY,
  DEFAULT_SETTINGS,
  modelTransportId,
  normalizeModelId,
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


test('ModelPro v0.1.38 Work transports cover all Picker-B profiles', () => {
  const pairs = {
    'gpt-5.6-sol': 'gpt-5.6-sol-wm',
    'gpt-5.6-terra': 'gpt-5.6-terra-wm',
    'gpt-5.6-luna': 'gpt-5.6-luna-wm',
    'gpt-6-astra': 'gpt-6-astra-wm',
    'gpt-6-sol': 'gpt-6-sol-wm',
    'gpt-6-luna': 'gpt-6-luna-wm',
  };
  for (const [model, transport] of Object.entries(pairs)) {
    assert.equal(modelTransportId(model), transport);
    assert.equal(normalizeModelId(transport), model);
  }
});
