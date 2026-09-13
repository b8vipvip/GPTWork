import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const runtime = fs.readFileSync(new URL('../tab-feature-runtime.js', import.meta.url), 'utf8');
const options = fs.readFileSync(new URL('../options.js', import.meta.url), 'utf8');
const masterUi = fs.readFileSync(new URL('../master-ui-controller.js', import.meta.url), 'utf8');
const pageRuntime = fs.readFileSync(new URL('../extension-page-runtime.js', import.meta.url), 'utf8');
const generation = fs.readFileSync(new URL('../runtime-generation.js', import.meta.url), 'utf8');

test('tab feature authority reads account snapshot directly and never self-messages the MV3 worker', () => {
  assert.match(runtime, /ACCOUNT_SNAPSHOT_KEY = 'gptlockAccountSnapshot'/);
  const backgroundState = runtime.match(/async function backgroundState\(tabId\) \{([\s\S]*?)\n\}/)?.[0] || '';
  const executableState = backgroundState.replace(/^\s*\/\/.*$/gm, '');
  assert.match(backgroundState, /chrome\.storage\.local\.get\(ACCOUNT_SNAPSHOT_KEY\)/);
  assert.match(backgroundState, /accountAllowsWindow\(account, windowId\)/);
  assert.doesNotMatch(executableState, /chrome\.runtime\.sendMessage|GPTLOCK_GET_STATE/);
});

test('master and feature activation distinguish login, entitlement and window quota', () => {
  assert.match(runtime, /code: 'AUTH_REQUIRED'/);
  assert.match(runtime, /code: 'ENTITLEMENT_REQUIRED'/);
  assert.match(runtime, /code: 'WINDOW_QUOTA_EXCEEDED'/);
});

test('settings never repaints the local Master switch from synced settings', () => {
  assert.doesNotMatch(options, /elements\.enabled\.checked\s*=/);
  assert.match(options, /#enabled is local-only Master authority/);
  assert.match(masterUi, /GPTWORK_MASTER_STATUS/);
  assert.match(masterUi, /GPTWORK_MASTER_SET/);
  assert.match(masterUi, /changes\[MASTER_KEY\]\.newValue === true/);
});

test('extension pages use one generation barrier before Master or feature protocol calls', () => {
  assert.match(generation, /RUNTIME_GENERATION_KEY = 'gptworkRuntimeGeneration'/);
  assert.match(pageRuntime, /await ensureRuntimeGeneration\(\)/);
  assert.match(pageRuntime, /chrome\.runtime\.reload\(\)/);
  assert.match(masterUi, /import\('\.\/extension-page-runtime\.js'\)/);
});

test('master failures are visible instead of silently reverting the switch', () => {
  assert.match(masterUi, /masterToast\(AUTH_MESSAGE\)/);
  assert.match(masterUi, /masterToast\(ENTITLEMENT_MESSAGE\)/);
  assert.match(masterUi, /总开关切换失败/);
});
