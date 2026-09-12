import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const popupJs = new URL('../popup.js', import.meta.url);
const popupShell = new URL('../popup-v0513-shell.js', import.meta.url);
const popupCss = new URL('../popup-v0513.css', import.meta.url);
const settingsShell = new URL('../settings-shell.js', import.meta.url);

test('default popup and settings expose account UI without legacy product-license compatibility', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.equal(manifest.action.default_popup, 'popup-v0513.html');
  assert.equal(manifest.options_ui.page, 'settings-v0521.html');
  assert.equal(manifest.background.service_worker, 'background-entry.js');

  const defaultPopup = new URL(`../${manifest.action.default_popup}`, import.meta.url);
  const settingsPage = new URL(`../${manifest.options_ui.page}`, import.meta.url);
  const [html, settingsHtml, js, shell, css, settingsRuntime] = await Promise.all([
    readFile(defaultPopup, 'utf8'),
    readFile(settingsPage, 'utf8'),
    readFile(popupJs, 'utf8'),
    readFile(popupShell, 'utf8'),
    readFile(popupCss, 'utf8'),
    readFile(settingsShell, 'utf8'),
  ]);

  assert.match(html, /账号登录/);
  assert.match(html, /id="loginForm"/);
  assert.match(html, /id="registerForm"/);
  assert.match(html, /id="accountCenter"/);
  assert.match(html, /popup-v0513-shell\.js/);
  assert.match(html, /popup-v0513\.css/);
  assert.match(settingsHtml, /GPTWork 总开关/);
  assert.match(settingsHtml, /data-gptwork-master-toggle="true"/);
  assert.match(settingsHtml, /settings-shell\.js/);

  for (const source of [html, settingsHtml, js, shell, css, settingsRuntime]) {
    assert.doesNotMatch(source, /GPTL-/);
    assert.doesNotMatch(source, /GPTLOCK-LICENSE|GPTLOCK_LICENSE/);
    assert.doesNotMatch(source, /LICENSE_UI_STALE/);
    assert.doesNotMatch(source, /licensePurchase|licenseActivate|licenseCode/);
    assert.doesNotMatch(source, /验证授权码|获取授权码|授权验证 \/ License/);
  }

  assert.match(shell, /SHELL_REVISION = 'v0513-single-authority-1'/);
  assert.match(shell, /gptlockPopupRuntimeInfo/);
  assert.match(shell, /getManifest\(\)\.options_ui\?\.page/);
  assert.match(shell, /#updates-auto/);

  assert.match(settingsRuntime, /SETTINGS_REVISION = 'v0521-single-authority-1'/);
  assert.match(settingsRuntime, /gptlockUiUpdateStatus/);
  assert.match(settingsRuntime, /SAFE_CORE_RECONCILE_PHASES/);
  assert.match(css, /grid-template-columns:\s*repeat\(4,/);
});
