import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const popup = fs.readFileSync(new URL('../popup-v0513.html', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const masterUi = fs.readFileSync(new URL('../master-ui-controller.js', import.meta.url), 'utf8');
const settingsShell = fs.readFileSync(new URL('../settings-shell.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
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

test('popup master switch uses explicit master authority and blocks duplicate writers', () => {
  assert.match(masterUi, /MASTER_KEY = 'gptworkEnabledLocal'/);
  assert.match(masterUi, /GPTWORK_MASTER_STATUS/);
  assert.match(masterUi, /GPTWORK_MASTER_SET/);
  assert.match(masterUi, /extension-page-runtime\.js/);
  assert.match(masterUi, /当前账户并发窗口超限/);
  assert.match(masterUi, /mouseenter/);
  assert.match(masterUi, /stopImmediatePropagation/);
});

test('Settings exposes the same master switch through the shared controller', () => {
  assert.match(settings, /data-gptwork-settings-master="true"/);
  assert.match(settings, /id="enabled"/);
  assert.doesNotMatch(settings, /id="enabled"[^>]*hidden/);
  assert.match(settingsShell, /import\('\.\/master-ui-controller\.js'\)/);
  assert.match(settingsShell, /only settings-page master writer/);
  assert.match(masterUi, /GPTWORK_MASTER_STATUS/);
  assert.match(masterUi, /GPTWORK_MASTER_SET/);
  assert.match(masterUi, /当前账户并发窗口超限/);
  assert.match(masterUi, /event\.stopImmediatePropagation\(\)/);
});

test('Work and Model lock are independent per-tab state and never overwrite Master', () => {
  const featureController = fs.readFileSync(new URL('../feature-toggle-controller.js', import.meta.url), 'utf8');
  assert.doesNotMatch(featureController, /GPTLOCK_SET_ENABLED/);
  assert.match(featureController, /GPTWORK_TAB_FEATURE_SET/);
  assert.match(settings, /按 ChatGPT 标签页隔离/);
  assert.match(settings, /仅当前 ChatGPT 标签页生效/);
  assert.match(settings, /同一 Chrome 窗口里的不同 ChatGPT 标签页也可以保持不同状态/);
  assert.doesNotMatch(settings, /同一窗口内(?:的)?标签页共享状态/);
});

test('background is the sole master runtime cleanup authority', () => {
  const stop = background.match(/async function stopBackgroundRuntime\([^)]*\) \{([\s\S]*?)\n\}/)?.[0] || '';
  assert.match(stop, /chrome\.alarms\.clear\(RECONNECT_ALARM\)/);
  assert.match(stop, /chrome\.alarms\.clear\(ACCOUNT_REFRESH_ALARM\)/);
  assert.match(stop, /networkMonitor\.detach\(tabId\)/);
  assert.match(stop, /setBadgeText\(\{ tabId, text: '' \}\)/);
  assert.doesNotMatch(background, /chrome\.runtime\.connectNative\s*=/);
  assert.doesNotMatch(backgroundEntry, /master-runtime-safety\.js/);
  assert.equal(fs.existsSync(new URL('../master-runtime-safety.js', import.meta.url)), false);
  assert.match(floatingMaster, /gptlock-indicator-host/);
  assert.match(floatingMaster, /gptlock-model-indicator-host/);
  assert.match(floatingMaster, /removeFloatingUi/);
});

test('window lifecycle listeners remain native registrations while master is disabled', () => {
  assert.match(background, /chrome\.windows\.onCreated\.addListener/);
  assert.match(background, /chrome\.windows\.onRemoved\.addListener/);
  assert.doesNotMatch(background, /\.addListener\s*=/);
});

test('tab feature authority is installed before the sole background lifecycle authority', () => {
  const tabIndex = backgroundEntry.indexOf("import './tab-feature-runtime.js'");
  const backgroundIndex = backgroundEntry.indexOf("import './background.js'");
  assert.ok(tabIndex >= 0);
  assert.ok(backgroundIndex > tabIndex);
  assert.match(backgroundEntry, /tabs in the same Chrome window never inherit/);
  assert.doesNotMatch(backgroundEntry, /master-runtime-safety\.js/);
});

test('content recovery stays off with the master disabled and lifecycle supervisor loads first', () => {
  assert.match(recovery, /MASTER_KEY = 'gptworkEnabledLocal'/);
  assert.match(recovery, /reason: 'master_disabled'/);
  assert.match(recovery, /masterRuntimeEnabled\(\)/);
  const scripts = manifest.content_scripts[0].js;
  assert.equal(scripts[0], 'content-runtime-lifecycle.js');
  assert.equal(scripts[1], 'content-local-error-capture.js');
  assert.equal(scripts[2], 'floating-ui-master-state.js');
});

test('floating model UI strips visible recent-request suffixes', () => {
  assert.match(floatingMaster, /RECENT_REQUEST_MARKER/);
  assert.match(floatingMaster, /replace\(RECENT_REQUEST_MARKER, ''\)/);
});
