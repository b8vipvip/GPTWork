import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('homepage and both account centers surface the GPTWork disclaimer', () => {
  const home = read('../public/index.html');
  const account = read('../public/account.html');
  const extensionAccount = read('../../extension/account.html');
  for (const source of [home, account, extensionAccount]) {
    assert.match(source, /免责声明/);
    assert.match(source, /并非 OpenAI 官方产品/);
    assert.match(source, /不能创建、增加、绕过或保证/);
  }
  assert.match(home, /id="disclaimer"/);
  assert.match(account, /id="accountDisclaimer"/);
});

test('release page loads installer-only filter and hides non-installer artifacts by policy', () => {
  const page = read('../public/releases.html');
  const helper = read('../public/order-countdown.js');
  assert.match(page, /仅展示用户需要安装的正式安装包/);
  assert.match(page, /order-countdown\.js/);
  assert.match(helper, /function isInstallerAssetLabel/);
  assert.match(helper, /\.exe\|\\\.msi\|\\\.deb/);
  assert.match(helper, /if \(!isInstallerAssetLabel\(link\.textContent\)\) link\.remove\(\)/);
});

test('guide steps size the exact title input smaller and the exact detail textarea larger with a simple editor', () => {
  const adminPage = read('../public/admin-website.html');
  const legacyEditor = read('../public/admin-release-mirror.js');
  const richEditor = read('../public/rich-text-style.js');
  const adminCss = read('../public/admin-website.css');
  const guide = read('../public/guide.html');
  const siteHelper = read('../public/order-countdown.js');
  assert.match(adminPage, /admin-release-mirror\.js/);
  assert.match(legacyEditor, /installGuideStepsEditor/);
  assert.match(richEditor, /installGuideStepsAdminEnhancer/);
  assert.match(richEditor, /titleInput\.maxLength = 160/);
  assert.match(richEditor, /bodyInput\.rows = 6/);
  assert.match(richEditor, /bodyInput\.maxLength = 1200/);
  assert.match(richEditor, /bodyLabel\.append\(toolbar, bodyInput\)/);
  assert.match(richEditor, /createTextStyleToolbar/);
  assert.match(adminCss, /guide-step-editor-row\{display:grid!important;grid-template-columns:220px minmax\(0,1fr\) 92px!important/);
  assert.match(adminCss, /input\[maxlength="160"\]\[aria-label\$="标题"\]\{width:220px!important;max-width:220px!important/);
  assert.match(adminCss, /textarea\[rows="6"\]\[maxlength="1200"\]\[aria-label\$="说明"\]\{display:block;width:100%!important;max-width:none!important/);
  assert.match(adminCss, /guide-step-body-field \.cms-style-toolbar\{display:flex!important;width:100%!important/);
  assert.match(richEditor, /target\.styles = \{ \.\.\.\(target\.styles \|\| \{\}\), body: bodyStyle \}/);
  assert.match(guide, /order-countdown\.js/);
  assert.match(siteHelper, /renderGuideStepsFromCms/);
  assert.match(siteHelper, /applyTextStyle\?\.\(body, item\?\.styles\?\.body/);
});

test('Windows installation docs state that Setup bundles extension files but browser confirmation remains required', () => {
  const install = read('../../docs/INSTALL.md');
  assert.match(install, /安装器已经包含与该版本配套的 GPTWork 浏览器扩展文件/);
  assert.match(install, /不会绕过浏览器安全确认静默启用扩展/);
});
