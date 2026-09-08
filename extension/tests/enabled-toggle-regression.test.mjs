import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const authGate = fs.readFileSync(new URL('../auth-gate.js', import.meta.url), 'utf8');
const controller = fs.readFileSync(new URL('../enabled-toggle-controller.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const popup = fs.readFileSync(new URL('../popup-v0513.html', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../settings-v0521.html', import.meta.url), 'utf8');

test('account gate no longer writes the enable switch disabled state', () => {
  assert.doesNotMatch(authGate, /el\.enabled\.disabled\s*=/);
  assert.match(authGate, /gptlock-entitlement-state/);
});

test('master enable switch uses local authoritative state and remains operable when sync quota is exhausted', () => {
  assert.match(controller, /LOCAL_ENABLED_KEY = 'gptworkEnabledLocal'/);
  assert.match(controller, /chrome\.storage\.local\.set/);
  assert.match(controller, /GPTLOCK_SET_ENABLED/);
  assert.match(controller, /stopImmediatePropagation\(\)/);
  assert.match(controller, /toggle\.checked = previous/);
  assert.doesNotMatch(controller, /chrome\.storage\.sync\.set/);
});

test('background owns the device-local master switch across restart and ignores synced enabled drift', () => {
  assert.match(background, /LOCAL_ENABLED_KEY = 'gptworkEnabledLocal'/);
  assert.match(background, /chrome\.storage\.local\.get\(LOCAL_ENABLED_KEY\)/);
  assert.match(background, /localEnabledOverride/);
  assert.match(background, /enabled: typeof localEnabledOverride === 'boolean' \? localEnabledOverride : syncedSettings\.enabled/);
  assert.match(background, /chrome\.storage\.local\.set\(\{ \[LOCAL_ENABLED_KEY\]: desired \}\)/);
  assert.doesNotMatch(background, /case 'GPTLOCK_SET_ENABLED':[\s\S]{0,900}chrome\.storage\.sync\.set/);
});

test('popup and settings both load the stable enable toggle controller', () => {
  const legacyIndex = popup.indexOf('src="popup.js"');
  const popupControllerIndex = popup.indexOf('src="enabled-toggle-controller.js"');
  assert.ok(legacyIndex >= 0);
  assert.ok(popupControllerIndex > legacyIndex);
  assert.match(settings, /src="enabled-toggle-controller\.js"/);
  assert.match(settings, /总开关保存在本机/);
});
