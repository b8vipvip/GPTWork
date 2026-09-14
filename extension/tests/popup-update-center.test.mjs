import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const popupCss = new URL('../popup-v0513.css', import.meta.url);
const popupJs = new URL('../popup.js', import.meta.url);
const optionsUpdate = new URL('../options-update.js', import.meta.url);
const backgroundUpdate = new URL('../background-update.js', import.meta.url);
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

test('settings page is the interactive update client while the service worker owns execution', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const settingsHtml = new URL(`../${manifest.options_ui.page}`, import.meta.url);
  const [html, js, popup] = await Promise.all([
    readFile(settingsHtml, 'utf8'),
    readFile(optionsUpdate, 'utf8'),
    readFile(popupJs, 'utf8'),
  ]);
  assert.match(html, /id="updates"/);
  assert.match(html, /id="updateProgress"/);
  assert.match(html, /id="updatePercent"/);
  assert.match(html, /id="updateLog"/);
  assert.doesNotMatch(html, /<button id="reconnect"/);
  assert.doesNotMatch(html, /<button id="logs"/);
  assert.match(html, /options-update\.js/);

  assert.match(js, /GPTWORK_UPDATE_STATUS_GET/);
  assert.match(js, /GPTWORK_UPDATE_CHECK/);
  assert.match(js, /GPTWORK_UPDATE_INSTALL/);
  assert.match(js, /UPDATE_STATUS_KEY/);
  assert.doesNotMatch(js, /fetchLatestRelease/);
  assert.doesNotMatch(js, /prepare_update/);
  assert.doesNotMatch(js, /connectNative\(/);
  assert.doesNotMatch(js, /chrome\.downloads\.download/);
  assert.doesNotMatch(js, /chrome\.runtime\.reload\(/);

  assert.match(popup, /GPTLOCK_OPEN_OPTIONS/);
  assert.doesNotMatch(popup, /GPTWORK_UPDATE_CHECK/);
  assert.doesNotMatch(popup, /GPTWORK_UPDATE_INSTALL/);
});

test('background updater owns bounded native polling and settings never performs reconnect/update primitives', async () => {
  const [background, settingsClient] = await Promise.all([
    readFile(backgroundUpdate, 'utf8'),
    readFile(optionsUpdate, 'utf8'),
  ]);
  assert.match(background, /NATIVE_TIMEOUT_MS/);
  assert.match(background, /INSTALL_TIMEOUT_MS/);
  assert.match(background, /nativeRequest\('get_status'/);
  assert.match(background, /nativeRequest\('prepare_update'/);
  assert.match(background, /chromeApi\.runtime\.reload\(\)/);
  assert.doesNotMatch(settingsClient, /GPTLOCK_RECONNECT/);
  assert.doesNotMatch(settingsClient, /nativeRequest\(/);
  assert.doesNotMatch(settingsClient, /prepare_update/);
});

test('Windows installer stages and atomically swaps the extension before finalizing the upgrade', async () => {
  const source = await readFile(installer, 'utf8');
  assert.match(source, /\[InstallDelete\]/);
  assert.match(source, /DestDir:\s*"\{app\}\\extension\.next"/);
  assert.match(source, /function RecoverInterruptedExtensionSwap\(\): Boolean/);
  assert.match(source, /function SwapExtensionPayload\(\): Boolean/);
  assert.match(source, /procedure RollbackExtensionSwap/);
  assert.match(source, /procedure FinishExtensionSwap/);
  assert.doesNotMatch(source, /Type:\s*filesandordirs;\s*Name:\s*"\{app\}\\extension"\s*$/m);
  assert.match(source, /function StopInstalledCoreProcesses\(\): Boolean/);
  assert.match(source, /function PrepareToInstall\(var NeedsRestart: Boolean\): String/);
  assert.match(source, /Get-Process -Name ''gptwork-core''/);
});
