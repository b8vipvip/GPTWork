import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const runtime = fs.readFileSync(new URL('../tab-feature-runtime.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const monitor = fs.readFileSync(new URL('../network-monitor.js', import.meta.url), 'utf8');
const controller = fs.readFileSync(new URL('../feature-toggle-controller.js', import.meta.url), 'utf8');
const work = fs.readFileSync(new URL('../work-mode-controller.js', import.meta.url), 'utf8');
const pageSync = fs.readFileSync(new URL('../multi-window-lock-sync.js', import.meta.url), 'utf8');
const nativeBridge = fs.readFileSync(new URL('../../native-core/src/bridge.rs', import.meta.url), 'utf8');
const nativeLib = fs.readFileSync(new URL('../../native-core/src/lib.rs', import.meta.url), 'utf8');

test('current feature state is still keyed by tab id pending window-authority migration', () => {
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

test('background derives debugger configuration from the target tab policy directly', () => {
  assert.match(background, /lockConfigurationForTabSync/);
  assert.match(background, /getLockConfiguration\(tabId\)/);
  assert.match(background, /effectivePolicyForTabSync\(tabId\)/);
  assert.match(background, /tab\.status === 'loading'/);
  assert.match(monitor, /getLockConfiguration\?\.\(tabId\)/);
  assert.doesNotMatch(background, /network-monitor-safety\.js|tab-feature-network-policy\.js/);
});

test('Native verification receives the effective tab policy without persisting it', () => {
  assert.match(background, /verifyObservation\(message\.observation \?\? \{\}, policy\)/);
  assert.match(background, /effectivePolicyForTabSync\(sender\.tab\.id\)/);
  assert.match(nativeBridge, /state\.verify_with_policy\(request, policy_override\)/);
  assert.match(nativeLib, /pub fn verify_with_policy/);
});

test('content-side Work handling and page alignment consume feature messages', () => {
  assert.match(work, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(work, /GPTWORK_TAB_FEATURE_STATE/);
  assert.match(pageSync, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(pageSync, /GPTWORK_TAB_FEATURE_STATE/);
});

test('quota denial uses the exact requested Chinese message', () => {
  assert.match(runtime, /WINDOW_QUOTA_MESSAGE = '当前账户并发窗口超限'/);
  assert.match(runtime, /WINDOW_QUOTA_EXCEEDED/);
});
