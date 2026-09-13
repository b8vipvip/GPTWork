import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

async function source(name) {
  return readFile(new URL(name, ROOT), 'utf8');
}

test('transient account initialization failures preserve the last authenticated snapshot', async () => {
  const client = await source('account-client.js');
  assert.match(client, /A transient transport\/server failure must not turn a still-valid local session/);
  assert.match(client, /state = \{ \.\.\.state, lastError: error\.message \};/);
  assert.match(client, /await chrome\.storage\.local\.set\(\{ \[SNAPSHOT_KEY\]: state \}\);/);
  assert.doesNotMatch(client, /catch \(error\) \{\s*return persist\(\{ authenticated: false, lastError: error\.message \}\);/s);
});

test('account client serializes startup hydration before accepting a new login session', async () => {
  const client = await source('account-client.js');
  assert.match(client, /let sessionHydrated = false;/);
  assert.match(client, /let hydratePromise = null;/);
  assert.match(client, /let initializePromise = null;/);
  assert.match(client, /if \(!sessionHydrated\) \{[\s\S]*token = typeof stored\[SESSION_KEY\]/);
  assert.match(client, /A stale storage\.get[\s\S]*must never overwrite a newer in-memory token\/snapshot/);
  const login = client.match(/async function login[\s\S]*?async function logout/)?.[0] ?? '';
  assert.match(login, /await initialize\(\);/);
  assert.ok(login.indexOf('await initialize();') < login.indexOf("request('/api/v1/auth/login'"));
  assert.match(login, /sessionHydrated = true;/);
  assert.match(login, /initialized = true;/);
});

test('account UI renders cached identity before a live state request can time out', async () => {
  const gate = await source('auth-gate.js');
  assert.match(gate, /const ACCOUNT_SNAPSHOT_KEY = 'gptlockAccountSnapshot';/);
  assert.match(gate, /cachedAccount = await readCachedAccount\(\);/);
  assert.match(gate, /if \(cachedAccount\) renderAccount\(cachedAccount\);/);
  assert.match(gate, /withTimeout\(sendMessage\(\{ type: 'GPTLOCK_GET_STATE' \}\)\)/);
  assert.match(gate, /A page\/runtime transport timeout is not an authentication failure/);
  assert.match(gate, /chrome\.storage\.onChanged\.addListener/);
  assert.doesNotMatch(gate, /catch \(error\) \{\s*accountAuthenticated = false;/s);
});

test('per-tab feature-state timeout preserves the last successful UI snapshot without writing it back', async () => {
  const controller = await source('feature-toggle-controller.js');
  assert.match(controller, /let lastFeatureState = null;/);
  assert.match(controller, /withTimeout\(runtimeMessage\(\{ type: 'GPTWORK_TAB_FEATURE_GET'/);
  assert.match(controller, /if \(lastFeatureState\) syncVisibleToggles\(lastFeatureState\);/);
  assert.match(controller, /State refresh delayed; keeping current feature state\./);
  assert.match(controller, /cached snapshot never becomes an authority and is never written/);
  assert.doesNotMatch(controller, /chrome\.storage\.(?:local|sync|session)\.set/);
});

test('feature toggles never reject from a stale cached account before asking runtime authority', async () => {
  const controller = await source('feature-toggle-controller.js');
  assert.match(controller, /The background\/window runtime is the sole[\s\S]*entitlement \+ quota authority/);
  assert.doesNotMatch(controller, /function requireActivation/);
  const changeFeature = controller.match(/async function changeFeature[\s\S]*?function bindFeatureToggle/)?.[0] ?? '';
  assert.match(changeFeature, /GPTWORK_TAB_FEATURE_SET/);
  assert.doesNotMatch(changeFeature, /requireActivation\(/);
  assert.match(changeFeature, /error\?\.code === 'ENTITLEMENT_REQUIRED'/);
  assert.match(changeFeature, /const snapshot = await reconcile\(\)\.catch/);
});

test('overlapping account reconciliations cannot let an older logged-out response win after login', async () => {
  const controller = await source('feature-toggle-controller.js');
  assert.match(controller, /let reconcileGeneration = 0;/);
  assert.match(controller, /const generation = \+\+reconcileGeneration;/);
  assert.match(controller, /if \(generation !== reconcileGeneration \|\| targetTabId !== currentTabId\) return snapshot;/);
});
