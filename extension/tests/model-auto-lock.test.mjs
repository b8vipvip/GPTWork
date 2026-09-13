import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../model-auto-lock.js', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../tab-feature-runtime.js', import.meta.url), 'utf8');

test('content auto-lock helper no longer mutates global policy from one tab', () => {
  assert.doesNotMatch(source, /chrome\.storage\.sync\.set/);
  assert.doesNotMatch(source, /gptworkWorkModeEnabled/);
  assert.doesNotMatch(source, /gptworkModelLockEnabled/);
  assert.match(source, /tab-feature-runtime\.js/);
});

test('tab feature authority derives Work models from the shared discovery catalog', () => {
  assert.match(runtime, /BASE_WORK_MODELS/);
  assert.match(runtime, /DISCOVERED_MODELS_KEY/);
  assert.match(runtime, /function workModels\(\)/);
  assert.match(runtime, /filter\(isAtLeastSol\)/);
  assert.match(runtime, /effectivePolicyForTabSync/);
});

test('Model lock and Work mode combine only inside the target tab effective policy', () => {
  assert.match(runtime, /feature\.workModeEnabled/);
  assert.match(runtime, /feature\.modelLockEnabled/);
  assert.match(runtime, /lockedModels: active\.length/);
  assert.match(runtime, /TAB_FEATURE_SESSION_KEY/);
});
