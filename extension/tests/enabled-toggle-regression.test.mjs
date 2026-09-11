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

test('feature controller authenticates before changing the legacy master state', () => {
  assert.match(controller, /WORK_MODE_KEY = 'gptworkWorkModeEnabled'/);
  assert.match(controller, /MODEL_LOCK_KEY = 'gptworkModelLockEnabled'/);
  assert.match(controller, /requireActivation\(currentAccount\)/);
  assert.match(controller, /GPTLOCK_SET_ENABLED/);
  assert.doesNotMatch(controller, /gptworkEnabledLocal/);
  const requireIndex = controller.indexOf('if (desired) requireActivation(currentAccount)');
  const featureWriteIndex = controller.indexOf('await withTimeout(localSet({ [key]: Boolean(desired) }))');
  assert.ok(requireIndex >= 0 && featureWriteIndex > requireIndex);
});

test('unauthenticated popup remains visible and protected actions can open login on demand', () => {
  assert.match(authGate, /showAppScreen\(\)/);
  assert.match(authGate, /gptlock-auth-required/);
  assert.match(authGate, /登录\/注册后可启用功能/);
  assert.match(popup, /<main id="appShell">/);
  assert.match(popup, /<section id="authShell"[^>]*hidden/);
});

test('background message receiver is registered before update control polling starts', () => {
  const backgroundIndex = backgroundEntry.indexOf("import './background.js'");
  const updaterIndex = backgroundEntry.indexOf("import './background-update.js'");
  assert.ok(backgroundIndex >= 0);
  assert.ok(updaterIndex > backgroundIndex);
});
