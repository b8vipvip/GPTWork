import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const shell = await readFile(new URL('popup-v0513-shell.js', ROOT), 'utf8');
const recovery = await readFile(new URL('popup-update-recovery.js', ROOT), 'utf8');
const css = await readFile(new URL('popup-v0513.css', ROOT), 'utf8');

test('popup loads recovery guidance for installed-update recovery timeouts', () => {
  assert.match(shell, /import '\.\/popup-update-recovery\.js'/);
  assert.match(recovery, /RECOVERY_TIMEOUT_MARKER = '更新已安装但功能恢复超时'/);
  assert.match(recovery, /status\?\.phase !== 'error'/);
  assert.match(recovery, /updateRuntimeProgress/);
  assert.match(recovery, /chrome\.runtime\.reload\(\)/);
  assert.match(recovery, /chrome:\/\/extensions\/\?id=\$\{chrome\.runtime\.id\}/);
});

test('stale 95 percent recovery errors self-heal from live extension, core, content and monitor state', () => {
  assert.match(recovery, /liveRecoveryReadiness/);
  assert.match(recovery, /compareVersions\(currentVersion, targetVersion\)/);
  assert.match(recovery, /GPTLOCK_GET_STATE/);
  assert.match(recovery, /liveState\?\.nativeStatus/);
  assert.match(recovery, /nativeStatus\.connected === true/);
  assert.match(recovery, /contentRuntimeReady/);
  assert.match(recovery, /chrome\.debugger\.getTargets/);
  assert.match(recovery, /phase: 'complete'/);
  assert.match(recovery, /percent: 100/);
  assert.match(recovery, /error: null/);
  assert.match(recovery, /failedAt: null/);
});

test('settings button is visually emphasized without changing its navigation contract', () => {
  assert.match(css, /\.account-settings-button/);
  assert.match(css, /border: 1\.5px solid #2563eb/);
  assert.match(css, /font-weight: 700/);
  assert.match(css, /\.account-settings-button::before/);
  assert.match(css, /content: '⚙'/);
});
