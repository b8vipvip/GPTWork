import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const authGate = fs.readFileSync(new URL('../auth-gate.js', import.meta.url), 'utf8');
const controller = fs.readFileSync(new URL('../enabled-toggle-controller.js', import.meta.url), 'utf8');
const bootstrap = fs.readFileSync(new URL('../local-enabled-bootstrap.js', import.meta.url), 'utf8');
const popup = fs.readFileSync(new URL('../popup-v0513.html', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const backgroundEntry = fs.readFileSync(new URL('../background-entry.js', import.meta.url), 'utf8');

test('account gate no longer writes the enable switch disabled state', () => {
  assert.doesNotMatch(authGate, /el\.enabled\.disabled\s*=/);
  assert.match(authGate, /gptlock-entitlement-state/);
});

test('master enable switch uses local authoritative state and recovers from Chrome sync quota', () => {
  assert.match(controller, /LOCAL_ENABLED_KEY = 'gptworkEnabledLocal'/);
  assert.match(controller, /chrome\.storage\.local\.set/);
  assert.match(controller, /GPTLOCK_SET_ENABLED/);
  assert.match(controller, /GPTLOCK_ACCOUNT_REFRESH/);
  assert.match(controller, /MAX_WRITE_OPERATIONS_PER_HOUR/);
  assert.match(controller, /stopImmediatePropagation\(\)/);
  assert.match(controller, /toggle\.checked = previous/);
  assert.match(controller, /syncQuotaFallback/);
  assert.doesNotMatch(controller, /chrome\.storage\.sync\.set/);
});

test('device-local master switch is re-applied after service-worker startup and sync changes', () => {
  assert.match(bootstrap, /gptworkEnabledLocal/);
  assert.match(bootstrap, /GPTLOCK_GET_STATE/);
  assert.match(bootstrap, /GPTLOCK_SET_ENABLED/);
  assert.match(bootstrap, /GPTLOCK_ACCOUNT_REFRESH/);
  assert.match(bootstrap, /areaName === 'sync' && changes\.settings/);
  assert.match(backgroundEntry, /import '\.\/local-enabled-bootstrap\.js'/);
});

test('popup and settings both load the stable enable toggle controller', () => {
  const legacyIndex = popup.indexOf('src="popup.js"');
  const popupControllerIndex = popup.indexOf('src="enabled-toggle-controller.js"');
  assert.ok(legacyIndex >= 0);
  assert.ok(popupControllerIndex > legacyIndex);
  assert.match(settings, /src="enabled-toggle-controller\.js"/);
  assert.match(settings, /总开关保存在本机/);
});
