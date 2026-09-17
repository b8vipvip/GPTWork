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
  assert.match(recovery, /coreReady === false/);
  assert.match(recovery, /pendingContentTabs/);
  assert.match(recovery, /pendingMonitorTabs/);
});

test('recovery guidance offers automatic reload plus a copyable chrome extensions address', () => {
  assert.match(recovery, /chrome\.runtime\.reload\(\)/);
  assert.match(recovery, /chrome:\/\/extensions\/\?id=\$\{chrome\.runtime\.id\}/);
  assert.match(recovery, /navigator\.clipboard\.writeText/);
  assert.match(recovery, /仅在扩展管理页重新加载不能升级本地 Core/);
  assert.match(recovery, /然后刷新 ChatGPT 页面/);
  assert.match(css, /\.update-recovery-guide/);
  assert.match(css, /\.update-recovery-address/);
});
