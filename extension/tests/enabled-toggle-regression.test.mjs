import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const authGate = fs.readFileSync(new URL('../auth-gate.js', import.meta.url), 'utf8');
const controller = fs.readFileSync(new URL('../feature-toggle-controller.js', import.meta.url), 'utf8');
const policy = fs.readFileSync(new URL('../policy.js', import.meta.url), 'utf8');
const popup = fs.readFileSync(new URL('../popup-v0513.html', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const backgroundEntry = fs.readFileSync(new URL('../background-entry.js', import.meta.url), 'utf8');

test('fresh installs default to an inert request interceptor', () => {
  assert.match(policy, /enabled:\s*false/);
});

test('popup and settings expose independent Work and model-lock feature gates', () => {
  for (const html of [popup, settings]) {
    assert.match(html, /id="workModeEnabled"/);
    assert.match(html, /id="modelLockEnabled"/);
    assert.match(html, /src="feature-toggle-controller\.js"/);
    assert.doesNotMatch(html, /src="enabled-toggle-controller\.js"/);
  }
});

test('feature controller delegates activation to the exact ChatGPT tab runtime authority', () => {
  assert.doesNotMatch(controller, /function requireActivation|requireActivation\(currentAccount\)/);
  assert.match(controller, /tab runtime validates the current[\s\S]*account entitlement/);
  assert.match(controller, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(controller, /GPTWORK_TAB_FEATURE_SET/);
  assert.match(controller, /tabId: targetTabId/);
  assert.match(controller, /feature: kind/);
  assert.match(controller, /active:\s*true, currentWindow:\s*true/);
  assert.match(controller, /同一 Chrome 窗口中的其他 ChatGPT 标签页不会共享状态/);
  assert.doesNotMatch(controller, /gptworkWorkModeEnabled/);
  assert.doesNotMatch(controller, /gptworkModelLockEnabled/);
  assert.doesNotMatch(controller, /GPTLOCK_SET_ENABLED/);
});

test('unauthenticated popup remains visible and protected actions can open login on demand', () => {
  assert.match(authGate, /showAppScreen\(\)/);
  assert.match(authGate, /gptlock-auth-required/);
  assert.match(authGate, /登录\/注册后可启用功能/);
  assert.match(popup, /<main id="appShell">/);
  assert.match(popup, /<section id="authShell"[^>]*hidden/);
});

test('tab feature authority loads before the sole background lifecycle authority', () => {
  const tabIndex = backgroundEntry.indexOf("import './tab-feature-runtime.js'");
  const backgroundIndex = backgroundEntry.indexOf("import './background.js'");
  const recoveryIndex = backgroundEntry.indexOf("import './content-runtime-recovery.js'");
  const updaterIndex = backgroundEntry.indexOf("import './background-update.js'");
  assert.ok(tabIndex >= 0);
  assert.ok(backgroundIndex > tabIndex);
  assert.ok(recoveryIndex > backgroundIndex);
  assert.ok(updaterIndex > recoveryIndex);
  assert.match(backgroundEntry, /same Chrome window never inherit/);
  assert.doesNotMatch(backgroundEntry, /master-runtime-safety\.js|tab-feature-network-policy\.js/);
});
