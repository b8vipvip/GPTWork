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

test('feature controller authenticates then changes the current ChatGPT window authority', () => {
  assert.match(controller, /requireActivation\(currentAccount\)/);
  assert.match(controller, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(controller, /GPTWORK_TAB_FEATURE_SET/);
  assert.match(controller, /tabId: currentTabId/);
  assert.match(controller, /feature: kind/);
  assert.match(controller, /currentWindow:\s*true/);
  assert.match(controller, /窗口内的 ChatGPT 标签页共享状态/);
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

test('master and window feature authorities load before the main background runtime', () => {
  const masterIndex = backgroundEntry.indexOf("import './master-runtime-safety.js'");
  const windowIndex = backgroundEntry.indexOf("import './tab-feature-runtime.js'");
  const backgroundIndex = backgroundEntry.indexOf("import './background.js'");
  const recoveryIndex = backgroundEntry.indexOf("import './content-runtime-recovery.js'");
  const updaterIndex = backgroundEntry.indexOf("import './background-update.js'");
  assert.ok(masterIndex >= 0);
  assert.ok(windowIndex > masterIndex);
  assert.ok(backgroundIndex > windowIndex);
  assert.ok(recoveryIndex > backgroundIndex);
  assert.ok(updaterIndex > recoveryIndex);
  assert.doesNotMatch(backgroundEntry, /tab-feature-network-policy\.js/);
});
