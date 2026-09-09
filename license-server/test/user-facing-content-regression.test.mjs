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
  assert.match(page, /order-countdown\.js/);
  assert.match(page, /只展示用户需要安装的正式安装包/);
  assert.match(helper, /function isInstallerAssetLabel/);
  assert.match(helper, /\.exe\|\\\.msi\|\\\.deb/);
  assert.match(helper, /if \(!isInstallerAssetLabel\(link\.textContent\)\) link\.remove\(\)/);
});

test('guide steps are editable in admin and rendered from website CMS', () => {
  const adminPage = read('../public/admin-website.html');
  const adminHelper = read('../public/admin-release-mirror.js');
  const guide = read('../public/guide.html');
  const siteHelper = read('../public/order-countdown.js');
  assert.match(adminPage, /admin-release-mirror\.js/);
  assert.match(adminHelper, /installGuideStepsEditor/);
  assert.match(adminHelper, /教程步骤的编号与页面结构由系统保护/);
  assert.match(guide, /order-countdown\.js/);
  assert.match(siteHelper, /renderGuideStepsFromCms/);
});

test('Windows installation docs state that Setup bundles extension files but browser confirmation remains required', () => {
  const install = read('../../docs/INSTALL.md');
  assert.match(install, /安装器已经包含与该版本配套的 GPTWork 浏览器扩展文件/);
  assert.match(install, /不会绕过浏览器安全确认静默启用扩展/);
});
