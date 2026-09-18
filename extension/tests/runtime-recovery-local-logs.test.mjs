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
const diagnostics = fs.readFileSync(new URL('../diagnostics.html', import.meta.url), 'utf8');
const diagnosticsSource = fs.readFileSync(new URL('../diagnostics.js', import.meta.url), 'utf8');

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
  assert.match(lifecycle, /chrome-extension:\\\/\\\/invalid/);

  const invalidationBody = lifecycle.match(/function isInvalidationError\(error\) \{([\s\S]*?)\n  \}\n\n  function terminalFailure/);
  assert.ok(invalidationBody, 'terminal invalidation matcher must stay explicit');
  const returnExpression = invalidationBody[1].match(/return\s+([^;]+);/)?.[1] || '';
  assert.match(returnExpression, /extension context invalidated/i);
  assert.doesNotMatch(returnExpression, /Receiving end does not exist/i);
});

test('runtime messaging wrapper is generation-owned and stops on synchronous or asynchronous invalidation', () => {
  assert.match(lifecycle, /sendMessage:\s*globalThis\.chrome\?\.runtime\?\.sendMessage/);
  assert.match(lifecycle, /function trackedSendMessage\(\.\.\.args\)/);
  assert.match(lifecycle, /chrome\?\.runtime\?\.sendMessage === trackedSendMessage/);
  assert.match(lifecycle, /chrome\.runtime\.sendMessage = original\.sendMessage/);
  assert.match(lifecycle, /chrome\.runtime\.sendMessage = trackedSendMessage/);
  assert.match(lifecycle, /original\.sendMessage\.apply\(globalThis\.chrome\.runtime, forwardedArgs\)/);
  assert.match(lifecycle, /original\.sendMessage\.apply\(globalThis\.chrome\.runtime, args\)/);
  assert.match(lifecycle, /result\.catch\(\(error\) =>/);
  assert.match(lifecycle, /send_message_async_context_invalidated/);
  assert.match(lifecycle, /globalThis\.chrome\?\.runtime\?\.lastError/);
});

test('content recovery is explicit, bounded, and owned by the update lifecycle', () => {
  assert.ok(manifest.permissions.includes('scripting'));
  assert.equal(manifest.content_scripts[0].js[1], 'content-local-error-capture.js');
  assert.match(recovery, /export async function contentRuntimeReady/);
  assert.match(recovery, /export async function recoverOpenTabs/);
  assert.match(recovery, /export function suspendContentRecovery/);
  assert.match(recovery, /export function resumeContentRecovery/);
  assert.match(recovery, /GPTLOCK_COLLECT_PAGE_STATE/);
  assert.match(recovery, /contentRuntimeConfirmedMissing/);
  assert.match(recovery, /chrome\.scripting\.executeScript/);
  assert.match(recovery, /content_runtime_recovered/);
  assert.match(recovery, /for \(const tab of candidates\)/);
  assert.match(recovery, /UPDATE_RECOVERY_GAP_MS/);
  assert.doesNotMatch(recovery, /chrome\.runtime\.onInstalled/);
  assert.doesNotMatch(recovery, /service_worker_start/);
  assert.doesNotMatch(recovery, /Promise\.allSettled\(tabs\.map/);
});

test('content lifecycle supports one proactive terminal quiesce before extension reload', () => {
  assert.match(lifecycle, /GPTWORK_CONTENT_PREPARE_RELOAD/);
  assert.match(lifecycle, /shutdown\('extension_reload_prepare'\)/);
  assert.doesNotMatch(lifecycle, /setInterval\([^)]*GPTWORK_CONTENT_PREPARE_RELOAD/);
});

test('dynamic recovery only injects classic content-script files declared by the manifest', () => {
  const match = recovery.match(/const CONTENT_SCRIPT_FILES = \[([\s\S]*?)\];/);
  assert.ok(match, 'recovery content bundle must be explicit');
  const files = [...match[1].matchAll(/'([^']+\.js)'/g)].map((item) => item[1]);
  assert.deepEqual(files, manifest.content_scripts[0].js);
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => file.endsWith('.js')));
  assert.ok(files.every((file) => !file.includes('background') && !file.includes('runtime-recovery')));
  for (const file of files) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^\s*(?:import|export)\s/m, `${file} must stay classic-script compatible`);
  }
});

test('content errors are persisted to the same bounded local runtime log buffer', () => {
  assert.match(contentErrorCapture, /window\.addEventListener\('error'/);
  assert.match(contentErrorCapture, /window\.addEventListener\('unhandledrejection'/);
  assert.match(contentErrorCapture, /runtimeLogs/);
  assert.match(contentErrorCapture, /slice\(-LIMIT\)/);
});

test('runtime logs have one diagnostics UI and are removed from settings', () => {
  assert.doesNotMatch(settings, /Local runtime logs|exportLocalLogs|clearLocalLogs|settings-local-logs\.js/);
  assert.match(diagnostics, /id="export"/);
  assert.match(diagnostics, /id="clear"/);
  assert.match(diagnosticsSource, /GPTLOCK_GET_RUNTIME_LOGS/);
  assert.match(diagnosticsSource, /GPTLOCK_CLEAR_RUNTIME_LOGS/);
  assert.match(diagnosticsSource, /runtimeLogs/);
});

test('auto verification copy is account-based and legacy authorization-code copy stays absent', () => {
  assert.match(popup, /使用当前 GPTWork 账号权益进行自动验证/);
  for (const source of [popup, popupShell, settings]) {
    assert.doesNotMatch(source, /请先验证授权码/);
    assert.doesNotMatch(source, /GPTLOCK-LICENSE|GPTLOCK_LICENSE|LICENSE_UI_STALE/);
  }
});
