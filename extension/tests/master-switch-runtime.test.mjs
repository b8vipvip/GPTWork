import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const popup = fs.readFileSync(new URL('../popup-v0513.html', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const masterUi = fs.readFileSync(new URL('../master-ui-controller.js', import.meta.url), 'utf8');
const settingsShell = fs.readFileSync(new URL('../settings-shell.js', import.meta.url), 'utf8');
const masterRuntime = fs.readFileSync(new URL('../master-runtime-safety.js', import.meta.url), 'utf8');
const backgroundEntry = fs.readFileSync(new URL('../background-entry.js', import.meta.url), 'utf8');
const floatingMaster = fs.readFileSync(new URL('../floating-ui-master-state.js', import.meta.url), 'utf8');
const recovery = fs.readFileSync(new URL('../content-runtime-recovery.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('popup header exposes an explicit master switch', () => {
  const header = popup.match(/<header>[\s\S]*?<\/header>/)?.[0] || '';
  assert.match(header, /data-gptwork-master-toggle="true"/);
  assert.match(header, /id="enabled"/);
  assert.match(header, /GPTWork 总开关/);
  assert.equal((popup.match(/id="enabled"/g) || []).length, 1);
  assert.match(popup, /src="master-ui-controller\.js"/);
});

test('popup master switch uses explicit master authority and quota feedback', () => {
  assert.match(masterUi, /MASTER_KEY = 'gptworkEnabledLocal'/);
  assert.match(masterUi, /GPTWORK_MASTER_STATUS/);
  assert.match(masterUi, /GPTWORK_MASTER_SET/);
  assert.match(masterUi, /当前账户并发窗口超限/);
  assert.match(masterUi, /mouseenter/);
  assert.match(masterUi, /stopImmediatePropagation/);
});

test('Settings statically exposes the same master switch and quota feedback', () => {
  assert.match(settings, /data-gptwork-settings-master="true"/);
  assert.match(settings, /id="enabled"/);
  assert.doesNotMatch(settings, /id="enabled"[^>]*hidden/);
  assert.match(settingsShell, /installSettingsMasterControl/);
  assert.match(settingsShell, /GPTWork 总开关/);
  assert.match(settingsShell, /GPTWORK_MASTER_STATUS/);
  assert.match(settingsShell, /GPTWORK_MASTER_SET/);
  assert.match(settingsShell, /当前账户并发窗口超限/);
  assert.match(settingsShell, /event\.stopImmediatePropagation\(\)/);
});

test('Work and Model lock no longer overwrite the explicit master state', () => {
  const featureController = fs.readFileSync(new URL('../feature-toggle-controller.js', import.meta.url), 'utf8');
  assert.doesNotMatch(featureController, /GPTLOCK_SET_ENABLED/);
  assert.match(featureController, /GPTWORK_TAB_FEATURE_SET/);
  assert.match(settings, /每个窗口\/标签可以保持不同状态/);
});

test('master off hard-stops Native Messaging, debugger sessions, alarms, badges, and floating UI', () => {
  assert.match(masterRuntime, /connectNative/);
  assert.match(masterRuntime, /nativePorts/);
  assert.match(masterRuntime, /port\.disconnect\(\)/);
  assert.match(masterRuntime, /chrome\.debugger\.detach/);
  assert.match(masterRuntime, /chrome\.alarms\.clear\(RECONNECT_ALARM\)/);
  assert.match(masterRuntime, /chrome\.alarms\.clear\(ACCOUNT_REFRESH_ALARM\)/);
  assert.match(masterRuntime, /setBadgeText\(\{ tabId: tab\.id, text: '' \}\)/);
  assert.match(masterRuntime, /GPTLOCK_MASTER_RUNTIME_STATE/);
  assert.match(floatingMaster, /gptlock-indicator-host/);
  assert.match(floatingMaster, /gptlock-model-indicator-host/);
  assert.match(floatingMaster, /removeFloatingUi/);
});

test('window removal cleanup remains active while master is disabled', () => {
  assert.match(masterRuntime, /windowRemovedLifecycleAlwaysOn = true/);
  assert.doesNotMatch(masterRuntime, /patchWindowCreatedEvent\(chrome\.windows\?\.onRemoved/);
});

test('master and tab guards are installed before background can open the native runtime', () => {
  const masterIndex = backgroundEntry.indexOf("import './master-runtime-safety.js'");
  const tabIndex = backgroundEntry.indexOf("import './tab-feature-runtime.js'");
  const backgroundIndex = backgroundEntry.indexOf("import './background.js'");
  assert.ok(masterIndex >= 0);
  assert.ok(tabIndex > masterIndex);
  assert.ok(backgroundIndex > tabIndex);
});

test('content recovery stays off with the master disabled and resumes when it is enabled', () => {
  assert.match(recovery, /MASTER_KEY = 'gptworkEnabledLocal'/);
  assert.match(recovery, /reason: 'master_disabled'/);
  assert.match(recovery, /master_enabled/);
  assert.equal(manifest.content_scripts[0].js[0], 'content-local-error-capture.js');
  assert.equal(manifest.content_scripts[0].js[1], 'floating-ui-master-state.js');
});

test('floating model UI strips visible recent-request suffixes', () => {
  assert.match(floatingMaster, /RECENT_REQUEST_MARKER/);
  assert.match(floatingMaster, /replace\(RECENT_REQUEST_MARKER, ''\)/);
});
