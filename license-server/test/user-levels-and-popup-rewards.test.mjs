import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const account = readFileSync(join(ROOT, 'license-server/account-system.mjs'), 'utf8');
const popup = readFileSync(join(ROOT, 'extension/popup.html'), 'utf8');
const popupCss = readFileSync(join(ROOT, 'extension/popup.css'), 'utf8');
const authGate = readFileSync(join(ROOT, 'extension/auth-gate.js'), 'utf8');
const extensionAccount = readFileSync(join(ROOT, 'extension/account.html'), 'utf8');
const extensionAccountJs = readFileSync(join(ROOT, 'extension/account.js'), 'utf8');
const rewards = readFileSync(join(ROOT, 'extension/popup-rewards.js'), 'utf8');
const background = readFileSync(join(ROOT, 'extension/background.js'), 'utf8');
const websiteAccount = readFileSync(join(ROOT, 'license-server/public/account.html'), 'utf8');
const websiteAccountRuntime = readFileSync(join(ROOT, 'license-server/public/account-commerce.js'), 'utf8');
const server = readFileSync(join(ROOT, 'license-server/server.mjs'), 'utf8');
const overview = readFileSync(join(ROOT, 'license-server/public/admin.html'), 'utf8');
const plans = readFileSync(join(ROOT, 'license-server/public/admin-plans.html'), 'utf8');
const users = readFileSync(join(ROOT, 'license-server/public/admin-users.html'), 'utf8');

test('user levels replace public membership semantics and enforce requested defaults', () => {
  assert.match(account, /code: 'deep'.*?maxDevices: 1, maxWindows: 3/s);
  assert.match(account, /code: 'heavy'.*?maxDevices: 5, maxWindows: 5/s);
  assert.match(account, /user_level TEXT NOT NULL DEFAULT 'normal'/);
  assert.match(account, /levelDefinitions/);
  assert.match(account, /requested\.slice\(0, remaining\)/);
  assert.match(background, /allowed\.includes\(windowKey\)/);
});

test('popup exposes check-in, share and upgrade in a single entitlement metadata row', () => {
  assert.match(popup, /id="accountCheckin"/);
  assert.match(popup, /<sup>\+1<\/sup>/);
  assert.match(popup, /id="accountShare"/);
  assert.match(popup, /<sup>\+7<\/sup>/);
  assert.match(popup, /id="accountUpgrade"/);
  assert.match(popup, /id="accountExpiry">权益有效期 —<\/span>/);
  assert.match(rewards, /\/api\/v1\/account\/checkin/);
  assert.match(rewards, /share\?\.url/);
  assert.match(authGate, /accountExpiry\.textContent = `权益有效期 \$\{localDate\(entitlement\.expiresAt\)\}`/);
  assert.match(popupCss, /\.account-meta\{display:flex!important;align-items:center;justify-content:space-between/);
  assert.doesNotMatch(popupCss, /\.account-meta\{display:grid!important/);
  assert.match(popupCss, /#accountUsage\{flex:0 0 auto;[^}]*white-space:nowrap/);
});

test('website account uses user level as the canonical display source and owns account actions in one runtime', () => {
  assert.match(websiteAccount, /<span>用户等级<\/span>/);
  assert.match(websiteAccount, /<span>权益有效期<\/span>/);
  assert.match(websiteAccount, /id="siteUpgrade"/);
  assert.match(websiteAccount, /id="dailyCheckin"/);
  assert.match(websiteAccount, /id="copyInvite"/);
  assert.match(websiteAccount, /<script type="module" src="\/account-commerce\.js"><\/script>/);
  assert.doesNotMatch(websiteAccount, /src="\/site\.js"/);
  assert.doesNotMatch(websiteAccount, /src="\/account-rewards\.js"/);
  assert.doesNotMatch(websiteAccount, /src="\/account-visibility\.js"/);
  assert.match(server, /url\.pathname === '\/account-commerce\.js'/);
  assert.match(websiteAccountRuntime, /entitlementSource'\)\.textContent = text\(account\.level\?\.name, '普通用户'\)/);
  assert.doesNotMatch(websiteAccountRuntime, /entitlement\.source === 'membership'/);
  assert.doesNotMatch(websiteAccountRuntime, /entitlement\.source === 'free'/);
  assert.match(websiteAccountRuntime, /renderRewards\(data\.rewards\)/);
  assert.match(websiteAccountRuntime, /renderUpgradePlans\(\)/);
});

test('account entitlement expiry wording is canonical across account surfaces', () => {
  assert.match(extensionAccount, /<span>权益有效期<\/span>/);
  assert.match(extensionAccount, /价格、权益有效期、设备和窗口权益/);
  assert.match(extensionAccountJs, /expiry\.textContent = `权益有效期 \$\{localDate\(entitlement\.expiresAt\)\}`/);
  assert.doesNotMatch(websiteAccount, /<span>有效至<\/span>/);
  assert.doesNotMatch(extensionAccount, /<span>有效期<\/span>/);
  assert.doesNotMatch(popup, />有效期 —<\/span>/);
});

test('admin membership tab is now user configuration and user list says user level', () => {
  assert.match(overview, />用户配置<\/a>/);
  assert.doesNotMatch(overview, />会员<\/a>/);
  assert.match(overview, />升级用户<\/span>/);
  assert.doesNotMatch(overview, />有效会员<\/span>/);
  assert.match(plans, /用户配置/);
  assert.match(plans, /普通、深度、重度/);
  assert.match(users, /<th>用户等级<\/th>/);
});
