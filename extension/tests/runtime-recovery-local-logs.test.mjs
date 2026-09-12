import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const entry = fs.readFileSync(new URL('../background-entry.js', import.meta.url), 'utf8');
const recovery = fs.readFileSync(new URL('../content-runtime-recovery.js', import.meta.url), 'utf8');
const lifecycle = fs.readFileSync(new URL('../content-runtime-lifecycle.js', import.meta.url), 'utf8');
const monitor = fs.readFileSync(new URL('../network-monitor.js', import.meta.url), 'utf8');
const contentErrorCapture = fs.readFileSync(new URL('../content-local-error-capture.js', import.meta.url), 'utf8');
const popup = fs.readFileSync(new URL('../popup-v0513.html', import.meta.url), 'utf8');
const popupShell = fs.readFileSync(new URL('../popup-v0513-shell.js', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const settingsLogs = fs.readFileSync(new URL('../settings-local-logs.js', import.meta.url), 'utf8');

test('network monitor is loaded directly without the removed legacy safety monkeypatch', () => {
  assert.doesNotMatch(entry, /network-monitor-safety\.js/);
  assert.match(entry, /import '\.\/background\.js'/);
  assert.match(monitor, /tab\.status === 'loading'|attachedTabs/);
});

test('terminal lifecycle supervisor loads before every other content runtime script', () => {
  assert.equal(manifest.content_scripts[0].js[0], 'content-runtime-lifecycle.js');
  assert.match(lifecycle, /Extension context invalidated/i);
  assert.match(lifecycle, /health_check_context_invalidated/);
  assert.match(lifecycle, /runtime_replaced/);
  assert.match(lifecycle, /observers\.clear\(\)/);
  assert.match(lifecycle, /removeTrackedListeners/);
  assert.match(lifecycle, /restorePatchedGlobals/);
});

test('existing ChatGPT tabs use bounded recovery after real install or update events', () => {
  assert.ok(manifest.permissions.includes('scripting'));
  assert.equal(manifest.content_scripts[0].js[1], 'content-local-error-capture.js');
  assert.match(recovery, /GPTLOCK_COLLECT_PAGE_STATE/);
  assert.match(recovery, /contentRuntimeConfirmedMissing/);
  assert.match(recovery, /chrome\.scripting\.executeScript/);
  assert.match(recovery, /content_runtime_recovered/);
  assert.match(recovery, /chrome\.runtime\.onInstalled/);
  assert.match(recovery, /\['install', 'update'\]/);
  assert.match(recovery, /for \(const tab of tabs\)/);
  assert.match(recovery, /UPDATE_RECOVERY_GAP_MS/);
  assert.doesNotMatch(recovery, /service_worker_start/);
  assert.doesNotMatch(recovery, /Promise\.allSettled\(tabs\.map/);
});

test('dynamic recovery only injects classic content-script files declared by the manifest', () => {
  const match = recovery.match(/const CONTENT_SCRIPT_FILES = \[([\s\S]*?)\];/);
  assert.ok(match, 'recovery content bundle must be explicit');
  const files = [...match[1].matchAll(/'([^']+\.js)'/g)].map((item) => item[1]);
  assert.deepEqual(files, manifest.content_scripts[0].js);
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => file.endsWith('.js')));
  assert.ok(files.every((file) => !file.includes('background') && !file.includes('runtime-recovery')));
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

test('auto verification copy is account-based and legacy authorization-code copy stays absent', () => {
  assert.match(popup, /使用当前 GPTWork 账号权益进行自动验证/);
  for (const source of [popup, popupShell, settings]) {
    assert.doesNotMatch(source, /请先验证授权码/);
    assert.doesNotMatch(source, /GPTLOCK-LICENSE|GPTLOCK_LICENSE|LICENSE_UI_STALE/);
  }
});
