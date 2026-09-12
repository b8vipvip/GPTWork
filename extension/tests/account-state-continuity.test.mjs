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
