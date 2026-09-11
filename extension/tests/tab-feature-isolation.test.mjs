import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const runtime = fs.readFileSync(new URL('../tab-feature-runtime.js', import.meta.url), 'utf8');
const policyShim = fs.readFileSync(new URL('../tab-feature-network-policy.js', import.meta.url), 'utf8');
const safety = fs.readFileSync(new URL('../network-monitor-safety.js', import.meta.url), 'utf8');
const controller = fs.readFileSync(new URL('../feature-toggle-controller.js', import.meta.url), 'utf8');
const work = fs.readFileSync(new URL('../work-mode-controller.js', import.meta.url), 'utf8');
const pageSync = fs.readFileSync(new URL('../multi-window-lock-sync.js', import.meta.url), 'utf8');
const nativeBridge = fs.readFileSync(new URL('../../native-core/src/bridge.rs', import.meta.url), 'utf8');
const nativeLib = fs.readFileSync(new URL('../../native-core/src/lib.rs', import.meta.url), 'utf8');

test('Work and Model lock state is keyed by tab id in storage.session', () => {
  assert.match(runtime, /TAB_FEATURE_SESSION_KEY = 'gptworkTabFeatureStatesV1'/);
  assert.match(runtime, /chrome\.storage\.session\.get/);
  assert.match(runtime, /chrome\.storage\.session\.set/);
  assert.match(runtime, /states\.set\(id, next\)/);
  assert.match(runtime, /states\.delete\(Number\(tabId\)\)/);
});

test('feature UI never writes legacy global Work or Model-lock flags', () => {
  assert.match(controller, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(controller, /GPTWORK_TAB_FEATURE_SET/);
  assert.doesNotMatch(controller, /chrome\.storage\.local\.set/);
  assert.doesNotMatch(controller, /GPTLOCK_SET_ENABLED/);
});

test('debugger attachment requires the target tab own feature gate', () => {
  assert.match(safety, /getTabFeatureState\(tabId\)/);
  assert.match(safety, /state\.workModeEnabled/);
  assert.match(safety, /state\.modelLockEnabled/);
  assert.doesNotMatch(safety, /gptworkWorkModeEnabled/);
});

test('network rewrite is serialized around the target tab policy', () => {
  assert.match(policyShim, /__gptworkFeatureTabId/);
  assert.match(policyShim, /requestQueues/);
  assert.match(policyShim, /lockConfigurationForTabSync\(tabId/);
  assert.match(policyShim, /originalHandlePausedRequest\.call\(this, tabId, params\)/);
});

test('Native verification receives the same tab policy without persisting it', () => {
  assert.match(policyShim, /requestId\.match\(\/\^cdp-/);
  assert.match(policyShim, /effectivePolicyForTabSync\(tabId\)/);
  assert.match(policyShim, /originalPostMessage\(\{ \.\.\.message, policy \}\)/);
  assert.match(nativeBridge, /state\.verify_with_policy\(request, policy_override\)/);
  assert.match(nativeLib, /pub fn verify_with_policy/);
});

test('content-side Work handling and page alignment consume tab feature messages', () => {
  assert.match(work, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(work, /GPTWORK_TAB_FEATURE_STATE/);
  assert.match(pageSync, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(pageSync, /GPTWORK_TAB_FEATURE_STATE/);
});

test('quota denial uses the exact requested Chinese message', () => {
  assert.match(runtime, /WINDOW_QUOTA_MESSAGE = '当前账户并发窗口超限'/);
  assert.match(runtime, /WINDOW_QUOTA_EXCEEDED/);
});
