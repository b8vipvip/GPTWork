import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_POLICY,
  DEFAULT_SETTINGS,
  modelTransportId,
  modelLockFamilyId,
  modelMatchesLock,
  normalizeModelId,
  normalizePolicy,
  normalizeReasoningLevel,
  normalizeSettings,
  toNativePolicy,
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
      workDefaultModel: 'gpt-6-astra',
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

test('native policy projection excludes extension-only Work default', () => {
  assert.deepEqual(
    toNativePolicy({
      lockedModels: ['gpt-6-astra', 'gpt-6-sol'],
      workDefaultModel: 'gpt-6-sol',
      allowedReasoningLevels: ['extra-high', 'high'],
      strictMode: true,
    }),
    {
      lockedModels: ['gpt-6-astra', 'gpt-6-sol'],
      allowedReasoningLevels: ['extra-high', 'high'],
      strictMode: true,
    },
  );
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
      workModeGuidanceEnabled: true,
      workModeFeatureEnabled: true,
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

test('only GPT number series and exact -thinking counterpart share a lock identity', () => {
  for (const version of ['6', '6.5', '7', '7.2.1']) {
    const base = `gpt-${version}`;
    const thinking = `${base}-thinking`;
    assert.equal(modelLockFamilyId(base), base);
    assert.equal(modelLockFamilyId(thinking), base);
    assert.equal(modelMatchesLock(base, thinking), true);
    assert.equal(modelMatchesLock(thinking, base), true);
    assert.equal(normalizeModelId(thinking), thinking, 'network protocol ID must remain raw');
  }
  for (const other of ['gpt-5.6-thinking', 'gpt-7-thinking', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-instant', 'gpt-6-thinking-extra', 'gpt-6.5-thinking']) {
    assert.equal(modelMatchesLock('gpt-6', other), false, other);
  }
  assert.equal(modelMatchesLock('gpt-5.6-sol', 'gpt-5.6-thinking'), false);
  assert.equal(modelMatchesLock('gpt-6', 'auto'), false);
});

test('display labels GPT 6 / GPT-6 and Sol/Thinking spacing share exact canonical IDs', () => {
  for (const [display, expected] of [
    ['GPT 6', 'gpt-6'],
    ['GPT-6', 'gpt-6'],
    ['gpt 5.6', 'gpt-5.6'],
    ['GPT 6 Sol', 'gpt-6-sol'],
    ['GPT-6 Sol', 'gpt-6-sol'],
    ['gpt 6 thinking', 'gpt-6-thinking'],
    ['GPT 6.5 Thinking', 'gpt-6.5-thinking'],
    ['GPT 7 Thinking', 'gpt-7-thinking'],
  ]) {
    assert.equal(normalizeModelId(display), expected, display);
    assert.equal(modelMatchesLock(display, expected), true, display);
  }
  assert.equal(modelMatchesLock('GPT 6', 'gpt-6-thinking'), true);
  assert.equal(modelMatchesLock('GPT 7', 'gpt-7-thinking'), true);
  assert.equal(modelMatchesLock('GPT 6 Sol', 'gpt-6-thinking'), false);
  assert.equal(modelMatchesLock('GPT 6 Thinking', 'gpt-6-sol'), false);
  assert.equal(modelMatchesLock('GPT 6', 'gpt-6-sol'), false);
  assert.deepEqual(normalizePolicy({
    lockedModels: ['GPT 6', 'gpt-6', 'GPT 6 Sol', 'gpt-6-sol'],
  }).lockedModels, ['gpt-6', 'gpt-6-sol']);
});
