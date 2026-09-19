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

test('feature state is keyed by concrete ChatGPT tab and never shared by windowId', () => {
  assert.match(runtime, /TAB_FEATURE_SESSION_KEY = 'gptworkTabFeatureStatesV2'/);
  assert.match(runtime, /states\.set\(id, next\)/);
  assert.match(runtime, /states\.get\(id\)/);
  assert.match(runtime, /tab_feature_changed/);
  assert.doesNotMatch(runtime, /states\.set\(windowId, next\)/);
  assert.doesNotMatch(runtime, /pushWindowFeatureState/);
  assert.doesNotMatch(runtime, /chrome\.windows\.onRemoved\.addListener/);
});

test('new ChatGPT tabs default Work mode and model locking on while explicit tab choices stay authoritative', () => {
  assert.match(runtime, /const DEFAULT_TAB_FEATURE_STATE = Object\.freeze\(\{[\s\S]*workModeEnabled: true,[\s\S]*modelLockEnabled: true/);
  assert.match(runtime, /states\.has\(id\) \? states\.get\(id\) : DEFAULT_TAB_FEATURE_STATE/);
  assert.match(runtime, /normalizeState\(\{ \.\.\.DEFAULT_TAB_FEATURE_STATE, \.\.\.states\.get\(id\), \.\.\.patch \}\)/);
  assert.match(runtime, /const feature = masterEnabled \? tabFeatureStateSync\(tabId\) : normalizeState\(null\)/);
});

test('temporary window-scoped state migrates once into independent per-tab copies', () => {
  assert.match(runtime, /LEGACY_TAB_FEATURE_SESSION_KEY = 'gptworkTabFeatureStatesV1'/);
  assert.match(runtime, /WINDOW_FEATURE_SESSION_KEY = 'gptworkWindowFeatureStatesV1'/);
  assert.match(runtime, /legacy_feature_scope_migrated_to_tabs/);
  assert.match(runtime, /states\.set\(tab\.id, normalizeState\(value\)\)/);
  assert.match(runtime, /chrome\.storage\.session\.remove\(\[LEGACY_TAB_FEATURE_SESSION_KEY, WINDOW_FEATURE_SESSION_KEY\]\)/);
});

test('moving a tab keeps that tabs own feature state instead of adopting destination window state', () => {
  const attached = runtime.match(/chrome\.tabs\.onAttached\.addListener\([\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(attached, /pushFeatureState\(tabId\)/);
  assert.match(attached, /same tab keeps its own/);
  assert.doesNotMatch(attached, /states\.set\(|states\.get\(attachInfo\.newWindowId\)/);
});

test('feature UI targets one exact tab and never writes legacy global Work or Model-lock flags', () => {
  assert.match(controller, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(controller, /GPTWORK_TAB_FEATURE_SET/);
  assert.match(controller, /Tab \$\{tab\.id\}/);
  assert.match(controller, /其他标签页不受影响/);
  assert.doesNotMatch(controller, /chrome\.storage\.local\.set/);
  assert.doesNotMatch(controller, /GPTLOCK_SET_ENABLED/);
});

test('master storage transition is the single fan-out and OFF pushes an immediate fail-open guard', () => {
  const masterSet = runtime.match(/if \(message\.type === 'GPTWORK_MASTER_SET'\) \{([\s\S]*?)\n  \}\n\n  throw new Error/)?.[1] || '';
  assert.match(masterSet, /chrome\.storage\.local\.set\(\{ \[MASTER_KEY\]: false \}\)/);
  assert.match(masterSet, /chrome\.storage\.local\.set\(\{ \[MASTER_KEY\]: true \}\)/);
  assert.doesNotMatch(masterSet, /pushAllFeatureStates\(/);
  assert.doesNotMatch(masterSet, /scheduleAccountRefresh\(/);

  const offBranch = masterSet.match(/if \(!desired\) \{([\s\S]*?)\n    \}\n\n    const state = await backgroundState/)?.[1] || '';
  assert.match(offBranch, /masterEnabled = false/);
  assert.match(offBranch, /disabledMasterSnapshot\(tabId\)/);
  assert.doesNotMatch(offBranch, /backgroundState\(|entitlementError\(|quotaExceeded\(/);

  const enablePersist = masterSet.indexOf("await chrome.storage.local.set({ [MASTER_KEY]: true })");
  const enableMemory = masterSet.indexOf('masterEnabled = true', enablePersist);
  assert.ok(enablePersist >= 0 && enableMemory > enablePersist, 'Master ON must become active only after local persistence succeeds');

  const push = runtime.match(/async function pushFeatureState\(tabId, featureState = null\) \{([\s\S]*?)\n\}/)?.[0] || '';
  assert.match(push, /if \(masterEnabled\) return/);
  assert.match(push, /type: 'GPTLOCK_GUARD_STATE'/);
  assert.match(push, /canSend: true/);
  assert.match(push, /allowKind: 'disabled'/);
  assert.match(push, /status: 'disabled'/);
  assert.match(push, /settings: \{ enabled: false \}/);

  const storageListener = runtime.match(/chrome\.storage\.onChanged\.addListener\(\(changes, areaName\) => \{([\s\S]*?)\n\}\);/)?.[0] || '';
  assert.match(storageListener, /changes\[MASTER_KEY\]/);
  assert.match(storageListener, /pushAllFeatureStates\(\)/);
});

test('background derives debugger configuration from the target tab policy directly', () => {
  assert.match(background, /getLockConfiguration\(tabId\)/);
  assert.match(background, /runtimePolicyForTabSync\(tabId\)/);
  assert.match(background, /const policy = effectivePolicyForTabSync\(tabId\)/);
  assert.match(background, /verificationTransactionForTab\(tabId\)/);
  assert.match(background, /tab\.status === 'loading'/);
  assert.match(monitor, /getLockConfiguration\?\.\(tabId\)/);
  assert.doesNotMatch(background, /network-monitor-safety\.js|tab-feature-network-policy\.js/);
});

test('Native verification receives the effective tab policy without persisting it', () => {
  assert.match(background, /verifyObservation\(message\.observation \?\? \{\}, policy\)/);
  assert.match(background, /runtimePolicyForTabSync\(sender\.tab\.id\)/);
  assert.match(nativeBridge, /state\.verify_with_policy\(request, policy_override\)/);
  assert.match(nativeLib, /pub fn verify_with_policy/);
});

test('content-side Work handling and page alignment consume feature messages', () => {
  assert.match(work, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(work, /GPTWORK_TAB_FEATURE_STATE/);
  assert.match(pageSync, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(pageSync, /GPTWORK_TAB_FEATURE_STATE/);
});

test('quota denial remains window-based even though feature state is tab-based', () => {
  assert.match(runtime, /WINDOW_QUOTA_MESSAGE = '当前账户并发窗口超限'/);
  assert.match(runtime, /accountAllowsWindow/);
  assert.match(runtime, /WINDOW_QUOTA_EXCEEDED/);
});
