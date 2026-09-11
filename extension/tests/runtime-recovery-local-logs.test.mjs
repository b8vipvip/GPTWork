import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const entry = fs.readFileSync(new URL('../background-entry.js', import.meta.url), 'utf8');
const safety = fs.readFileSync(new URL('../network-monitor-safety.js', import.meta.url), 'utf8');
const recovery = fs.readFileSync(new URL('../content-runtime-recovery.js', import.meta.url), 'utf8');
const contentErrorCapture = fs.readFileSync(new URL('../content-local-error-capture.js', import.meta.url), 'utf8');
const popup = fs.readFileSync(new URL('../popup-v0513.html', import.meta.url), 'utf8');
const popupShell = fs.readFileSync(new URL('../popup-v0513-shell.js', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const settingsLogs = fs.readFileSync(new URL('../settings-local-logs.js', import.meta.url), 'utf8');

test('debugger safety is installed before background creates the network monitor', () => {
  const safetyIndex = entry.indexOf("import './network-monitor-safety.js'");
  const backgroundIndex = entry.indexOf("import './background.js'");
  assert.ok(safetyIndex >= 0);
  assert.ok(backgroundIndex > safetyIndex);
  assert.match(safety, /tab\?\.status === 'loading'/);
  assert.match(safety, /monitor_attach_deferred_loading/);
  assert.match(safety, /gptworkWorkModeEnabled/);
  assert.match(safety, /gptworkModelLockEnabled/);
  assert.match(safety, /monitor_attach_suppressed_no_feature_gate/);
});

test('existing ChatGPT tabs can recover a missing content receiver after reload or update', () => {
  assert.ok(manifest.permissions.includes('scripting'));
  assert.equal(manifest.content_scripts[0].js[0], 'content-local-error-capture.js');
  assert.match(recovery, /GPTLOCK_COLLECT_PAGE_STATE/);
  assert.match(recovery, /chrome\.scripting\.executeScript/);
  assert.match(recovery, /content_runtime_recovered/);
  assert.match(recovery, /changeInfo\.status === 'complete'/);
  assert.match(recovery, /chrome\.tabs\.onActivated/);
});

test('content errors are persisted to the same bounded local runtime log buffer', () => {
  assert.match(contentErrorCapture, /window\.addEventListener\('error'/);
  assert.match(contentErrorCapture, /window\.addEventListener\('unhandledrejection'/);
  assert.match(contentErrorCapture, /runtimeLogs/);
  assert.match(contentErrorCapture, /slice\(-LIMIT\)/);
});

test('settings exposes local log export, clear, and detailed diagnostics controls', () => {
  assert.match(settings, /id="exportLocalLogs"/);
  assert.match(settings, /id="clearLocalLogs"/);
  assert.match(settings, /id="openLocalDiagnostics"/);
  assert.match(settings, /src="settings-local-logs\.js"/);
  assert.match(settingsLogs, /GPTLOCK_GET_RUNTIME_LOGS/);
  assert.match(settingsLogs, /GPTLOCK_CLEAR_RUNTIME_LOGS/);
  assert.match(settingsLogs, /application\/x-ndjson/);
  assert.match(settingsLogs, /runtimeLogs:\s*\[\]/);
});

test('auto verification copy is account-based and stale license-code tooltip text is purged', () => {
  assert.match(popup, /使用当前 GPTWork 账号权益进行自动验证/);
  assert.doesNotMatch(popup, /请先验证授权码/);
  assert.doesNotMatch(settings, /请先验证授权码/);
  assert.match(popupShell, /授权码\|授权额度/);
  assert.match(popupShell, /Auto verify with account entitlement/);
});
