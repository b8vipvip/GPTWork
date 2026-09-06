import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const popupCss = new URL('../popup-v0513.css', import.meta.url);
const optionsUpdate = new URL('../options-update.js', import.meta.url);
const installer = new URL('../../packaging/windows/GPTWork.iss', import.meta.url);

test('popup exposes only the four user-facing actions and keeps reconnect/log controls hidden', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const popupHtml = new URL(`../${manifest.action.default_popup}`, import.meta.url);
  const [html, css] = await Promise.all([readFile(popupHtml, 'utf8'), readFile(popupCss, 'utf8')]);
  for (const id of ['autoVerify', 'checkUpdate', 'help', 'options']) assert.match(html, new RegExp(`<button id="${id}"`));
  assert.match(html, /<button id="help"[^>]*>使用帮助<\/button>\s*<button id="options"/);
  assert.doesNotMatch(html, /<button id="reconnect"/);
  assert.doesNotMatch(html, /<button id="logs"/);
  assert.match(html, /id="reconnect" hidden/);
  assert.match(html, /id="logs" hidden/);
  assert.match(css, /grid-template-columns:\s*repeat\(4,/);
});

test('settings page owns the real-time updater without verbose reconnect or release help copy', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const settingsHtml = new URL(`../${manifest.options_ui.page}`, import.meta.url);
  const [html, js] = await Promise.all([readFile(settingsHtml, 'utf8'), readFile(optionsUpdate, 'utf8')]);
  assert.match(html, /id="updates"/);
  assert.match(html, /id="updateProgress"/);
  assert.match(html, /id="updatePercent"/);
  assert.match(html, /id="updateLog"/);
  assert.doesNotMatch(html, /<button id="reconnect"/);
  assert.doesNotMatch(html, /<button id="logs"/);
  assert.doesNotMatch(html, /断线后自动重试/);
  assert.doesNotMatch(html, /从 GitHub 正式 Release 检查版本/);
  assert.doesNotMatch(html, /校验 SHA-256 后静默安装/);
  assert.match(html, /options-update\.js/);
  assert.match(js, /#updates-auto/);
  assert.match(js, /fetchLatestRelease/);
  assert.match(js, /prepare_update/);
  assert.match(js, /bytesReceived/);
  assert.match(js, /UPDATE_STATUS_KEY/);
});

test('updater polls the native core directly with bounded requests instead of full background reconnects', async () => {
  const source = await readFile(optionsUpdate, 'utf8');
  assert.match(source, /INSTALL_PROBE_TIMEOUT_MS/);
  assert.match(source, /RUNTIME_MESSAGE_TIMEOUT_MS/);
  assert.match(source, /nativeRequest\('get_status'/);
  assert.doesNotMatch(source, /GPTLOCK_RECONNECT/);
  assert.doesNotMatch(source, /setBusy\(true;/);
});

test('Windows installer removes stale UI and stops the installed core before replacing binaries', async () => {
  const source = await readFile(installer, 'utf8');
  assert.match(source, /\[InstallDelete\]/);
  assert.match(source, /Type:\s*filesandordirs;\s*Name:\s*"\{app\}\\extension"/);
  assert.match(source, /function StopInstalledCoreProcesses\(\): Boolean/);
  assert.match(source, /function PrepareToInstall\(var NeedsRestart: Boolean\): String/);
  assert.match(source, /Get-Process -Name ''gptwork-core''/);
});
