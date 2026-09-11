import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const popup = fs.readFileSync(new URL('../popup-v0513.html', import.meta.url), 'utf8');
const masterUi = fs.readFileSync(new URL('../master-ui-controller.js', import.meta.url), 'utf8');
const settingsShell = fs.readFileSync(new URL('../settings-shell.js', import.meta.url), 'utf8');
const masterRuntime = fs.readFileSync(new URL('../master-runtime-safety.js', import.meta.url), 'utf8');
const backgroundEntry = fs.readFileSync(new URL('../background-entry.js', import.meta.url), 'utf8');
const floatingMaster = fs.readFileSync(new URL('../floating-ui-master-state.js', import.meta.url), 'utf8');
const recovery = fs.readFileSync(new URL('../content-runtime-recovery.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('popup header replaces the old closed verdict pill with an explicit master switch', () => {
  const header = popup.match(/<header>[\s\S]*?<\/header>/)?.[0] || '';
  assert.match(header, /data-gptwork-master-toggle="true"/);
  assert.match(header, /id="enabled"/);
  assert.match(header, /GPTWork 总开关/);
  assert.doesNotMatch(header, /id="verdict"/);
  assert.doesNotMatch(header, /class="verdict/);
  assert.equal((popup.match(/id="enabled"/g) || []).length, 1);
  assert.match(popup, /src="master-ui-controller\.js"/);
});

test('Work and Model lock no longer get to overwrite the explicit popup master state', () => {
  assert.match(masterUi, /GPTLOCK_SET_ENABLED/);
  assert.match(masterUi, /GPTLOCK_ACCOUNT_REFRESH/);
  assert.match(masterUi, /explicitMasterAction/);
  assert.match(settingsShell, /Legacy feature code still/);
  assert.match(settingsShell, /GPTLOCK_ACCOUNT_REFRESH/);
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

test('master guard is installed before background can open the native runtime', () => {
  const guardIndex = backgroundEntry.indexOf("import './master-runtime-safety.js'");
  const backgroundIndex = backgroundEntry.indexOf("import './background.js'");
  assert.ok(guardIndex >= 0);
  assert.ok(backgroundIndex > guardIndex);
});

test('content recovery stays off with the master disabled and resumes when it is enabled', () => {
  assert.match(recovery, /MASTER_KEY = 'gptworkEnabledLocal'/);
  assert.match(recovery, /reason: 'master_disabled'/);
  assert.match(recovery, /master_enabled/);
  assert.equal(manifest.content_scripts[0].js[0], 'content-local-error-capture.js');
  assert.equal(manifest.content_scripts[0].js[1], 'floating-ui-master-state.js');
  assert.equal(manifest.content_scripts[0].js.includes('floating-ui-master-state.js'), true);
});

test('floating model UI strips every visible recent-request suffix while preserving historical state internally', () => {
  assert.match(floatingMaster, /RECENT_REQUEST_MARKER/);
  assert.match(floatingMaster, /replace\(RECENT_REQUEST_MARKER, ''\)/);
  assert.match(floatingMaster, /querySelectorAll\('\.model-value'\)/);
  assert.match(floatingMaster, /querySelectorAll\('\[title\]'\)/);
});
