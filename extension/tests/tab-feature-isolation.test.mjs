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

test('feature state is keyed by Chrome window while tab messages stay backward compatible', () => {
  assert.match(runtime, /WINDOW_FEATURE_SESSION_KEY = 'gptworkWindowFeatureStatesV1'/);
  assert.match(runtime, /resolveWindowIdForTab/);
  assert.match(runtime, /states\.set\(windowId, next\)/);
  assert.match(runtime, /chrome\.windows\.onRemoved\.addListener/);
  assert.match(runtime, /pushWindowFeatureState/);
  assert.doesNotMatch(runtime, /states\.set\(id, next\)/);
});

test('legacy tab session state is migrated once into window state', () => {
  assert.match(runtime, /TAB_FEATURE_SESSION_KEY = 'gptworkTabFeatureStatesV1'/);
  assert.match(runtime, /migrateLegacyTabSession/);
  assert.match(runtime, /chrome\.storage\.session\.remove\(TAB_FEATURE_SESSION_KEY\)/);
});

test('feature UI never writes legacy global Work or Model-lock flags', () => {
  assert.match(controller, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(controller, /GPTWORK_TAB_FEATURE_SET/);
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
