import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const popupCss = new URL('../popup-v0513.css', import.meta.url);
const popupNavigation = new URL('../popup-navigation.js', import.meta.url);
const updateHtml = new URL('../update.html', import.meta.url);
const updateEntry = new URL('../update-entry.js', import.meta.url);
const optionsUpdate = new URL('../options-update.js', import.meta.url);
const moduleNav = new URL('../module-nav.js', import.meta.url);
const backgroundUpdate = new URL('../background-update.js', import.meta.url);
const installer = new URL('../../packaging/windows/GPTWork.iss', import.meta.url);

test('popup keeps settings inside the account card and gives three primary actions more room', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const popupHtml = new URL(`../${manifest.action.default_popup}`, import.meta.url);
  const [html, css] = await Promise.all([readFile(popupHtml, 'utf8'), readFile(popupCss, 'utf8')]);

  for (const id of ['autoVerify', 'checkUpdate', 'help', 'options']) {
    assert.match(html, new RegExp(`<button id="${id}"`));
  }
  const accountCard = html.match(/<section class="account-card">([\s\S]*?)<\/section>/)?.[1] || '';
  const actions = html.match(/<div class="actions"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(accountCard, /id="options"[^>]*>设置<\/button>/);
  for (const id of ['autoVerify', 'checkUpdate', 'help']) assert.match(actions, new RegExp(`id="${id}"`));
  assert.doesNotMatch(actions, /id="options"/);
  assert.doesNotMatch(html, /<button id="reconnect"/);
  assert.doesNotMatch(html, /<button id="logs"/);
  assert.match(html, /id="reconnect" hidden/);
  assert.match(html, /id="logs" hidden/);
  assert.match(html, /src="popup-navigation\.js"/);
  assert.match(css, /grid-template-columns:\s*repeat\(3,/);
  assert.match(css, /margin-top:\s*14px/);
  assert.match(css, /min-height:\s*38px/);
  assert.match(css, /\.account-settings-button/);
  assert.match(css, /max-width:\s*390px/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /word-break:\s*break-word/);
});

test('popup update action opens the dedicated update center and requests an immediate check', async () => {
  const [navigation, page, entry, client] = await Promise.all([
    readFile(popupNavigation, 'utf8'),
    readFile(updateHtml, 'utf8'),
    readFile(updateEntry, 'utf8'),
    readFile(optionsUpdate, 'utf8'),
  ]);

  assert.match(navigation, /chrome\.runtime\.getURL\('update\.html\?check=1'\)/);
  assert.match(navigation, /stopImmediatePropagation\(\)/);
  assert.match(page, /data-gptwork-module="update"/);
  assert.match(page, /id="updates"/);
  assert.match(page, /id="updateProgress"/);
  assert.match(page, /id="updatePercent"/);
  assert.match(page, /id="updateLog"/);
  assert.match(page, /src="update-entry\.js"/);
  assert.match(entry, /import '\.\/options-update\.js'/);
  assert.match(entry, /URLSearchParams/);
  assert.match(entry, /getElementById\('checkUpdateNow'\)\?\.click\(\)/);

  assert.match(client, /GPTWORK_UPDATE_STATUS_GET/);
  assert.match(client, /GPTWORK_UPDATE_CHECK/);
  assert.match(client, /GPTWORK_UPDATE_INSTALL/);
  assert.match(client, /UPDATE_STATUS_KEY/);
  assert.doesNotMatch(client, /fetchLatestRelease/);
  assert.doesNotMatch(client, /prepare_update/);
  assert.doesNotMatch(client, /connectNative\(/);
  assert.doesNotMatch(client, /chrome\.downloads\.download/);
  assert.doesNotMatch(client, /chrome\.runtime\.reload\(/);
});

test('settings no longer embeds update center and remaining standalone modules share navigation', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const settingsUrl = new URL(`../${manifest.options_ui.page}`, import.meta.url);
  const pages = [
    ['settings', settingsUrl],
    ['account', new URL('../account.html', import.meta.url)],
    ['help', new URL('../help.html', import.meta.url)],
    ['update', updateHtml],
  ];
  const navigation = await readFile(moduleNav, 'utf8');
  const settings = await readFile(settingsUrl, 'utf8');

  assert.doesNotMatch(settings, /id="updates"/);
  assert.doesNotMatch(settings, /options-update\.js/);
  for (const [id, url] of pages) {
    const html = await readFile(url, 'utf8');
    assert.match(html, new RegExp(`data-gptwork-module="${id}"`));
    assert.match(html, /module-nav\.css/);
    assert.match(html, /module-nav\.js/);
  }
  for (const path of ['account.html', 'settings-v0521.html', 'help.html', 'update.html']) {
    assert.match(navigation, new RegExp(path.replace('.', '\\.')));
  }
  assert.match(navigation, /aria-current/);
});

test('background updater owns bounded native polling and update page never performs reconnect/update primitives directly', async () => {
  const [background, updateClient] = await Promise.all([
    readFile(backgroundUpdate, 'utf8'),
    readFile(optionsUpdate, 'utf8'),
  ]);
  assert.match(background, /NATIVE_TIMEOUT_MS/);
  assert.match(background, /INSTALL_TIMEOUT_MS/);
  assert.match(background, /nativeRequest\('get_status'/);
  assert.match(background, /nativeRequest\('prepare_update'/);
  assert.match(background, /chromeApi\.runtime\.reload\(\)/);
  assert.doesNotMatch(updateClient, /GPTLOCK_RECONNECT/);
  assert.doesNotMatch(updateClient, /nativeRequest\(/);
  assert.doesNotMatch(updateClient, /prepare_update/);
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
