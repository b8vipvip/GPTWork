import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [server, adminHtml, adminUi, popup, popupCss, auth, rewards, accountHtml,
  accountCss, accountRuntime, websiteHtml, websiteRuntime, smoke] = await Promise.all([
  read('../license-server/account-system-base.mjs'),
  read('../license-server/public/admin-plans.html'),
  read('../license-server/public/admin.js'),
  read('popup-v0513.html'),
  read('popup-v0513.css'),
  read('auth-gate.js'),
  read('popup-rewards.js'),
  read('account.html'),
  read('account.css'),
  read('account.js'),
  read('../license-server/public/account.html'),
  read('../license-server/public/account-commerce.js'),
  read('../license-server/test/smoke.test.mjs'),
]);

test('server gate defaults on and bypasses only entitlement expiry and device/window quota', () => {
  assert.match(server, /function entitlementLimitsEnabled\(\)\s*\{\s*return getSetting\('account_entitlement_limits_enabled', '1'\) !== '0'/);
  assert.match(server, /active = Boolean\(user && user\.status === 'active' && emailAccessSatisfied\(user\)\)/);
  assert.match(server, /limitsEnabled: entitlementLimitsEnabled\(\)/);
  assert.match(server, /if \(entitlementLimitsEnabled\(\) && count >= limit\)/);
  assert.match(server, /entitlementLimitsEnabled\(\) \? requested\.slice\(0, remaining\) : requested/);
  assert.match(server, /entitlementLimitsEnabled: entitlementLimitsEnabled\(\)/);
  assert.match(server, /input\.entitlementLimitsEnabled/);
  assert.match(server, /'INVALID_ENTITLEMENT_LIMITS_GATE'/);
  assert.match(server, /if \(!session\) fail\(401, 'AUTH_REQUIRED'/);
  assert.match(smoke, /unrestrictedHeartbeat/);
  assert.match(smoke, /expiredAgain\.data\.account\.entitlement\.active, false/);
});

test('user configuration page exposes a single explicitly saved and persisted entitlement gate', () => {
  assert.match(adminHtml, /id="entitlementLimitsEnabled" type="checkbox" checked/);
  assert.match(adminHtml, /id="saveEntitlementLimitGate"/);
  assert.match(adminUi, /async function loadEntitlementLimitGate\(/);
  assert.match(adminUi, /async function saveEntitlementLimitGate\(/);
  assert.match(adminUi, /entitlementLimitsEnabled: el\.entitlementLimitsEnabled\.checked/);
  assert.match(adminUi, /page === 'plans'\) await Promise\.all\(\[loadPlans\(\), loadEntitlementLimitGate\(\)\]\)/);
});

test('extension popup hides all tier/expiry/quota/upgrade/rewards UI when entitlements are off', () => {
  assert.match(popup, /class="account-tier-row" data-entitlement-limit hidden/);
  assert.match(popup, /class="account-meta" data-entitlement-limit hidden/);
  assert.match(popupCss, /\[data-entitlement-limit\]\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.match(auth, /document\.querySelectorAll\('\[data-entitlement-limit\]'\)/);
  assert.match(auth, /el\.accountUpgrade\.hidden = !limitsEnabled/);
  assert.match(auth, /detail: \{ authenticated, active: Boolean\(entitlement\.active\), limitsEnabled \}/);
  assert.match(rewards, /entitlementLimitsEnabled = event\.detail\?\.authenticated === true && event\.detail\?\.limitsEnabled === true/);
  assert.match(rewards, /if \(!entitlementLimitsEnabled\) return;/);
});

test('account and website never expose entitlement-specific sections when server gate is disabled', () => {
  assert.match(accountHtml, /data-entitlement-limit hidden/);
  assert.match(accountHtml, /id="upgradeDialog"[^>]*data-entitlement-limit/);
  assert.match(accountHtml, /id="recentOrdersSection" data-entitlement-limit hidden/);
  assert.match(accountCss, /body\[data-entitlement-limits="off"\] \[data-entitlement-limit\]\{display:none!important\}/);
  assert.match(accountRuntime, /document\.body\.dataset\.entitlementLimits = authenticated && !limitsEnabled \? 'off' : 'on'/);
  assert.match(accountRuntime, /account\?\.entitlement\?\.limitsEnabled === false/);
  assert.match(websiteHtml, /data-entitlement-limits="unknown"/);
  assert.match(websiteHtml, /body:not\(\[data-entitlement-limits="on"\]\) \[data-entitlement-limit\]\{display:none!important\}/);
  assert.match(websiteRuntime, /document\.body\.dataset\.entitlementLimits = limitsEnabled \? 'on' : 'off'/);
  assert.match(websiteRuntime, /if \(state\.account\?\.entitlement\?\.limitsEnabled === false\) return;/);
});

test('popup renders entitlement rows only for enabled accounts while keeping login/account available', () => {
  const start = auth.indexOf('function renderAccount(account) {');
  const end = auth.indexOf('\nasync function refreshGate()', start);
  assert.ok(start >= 0 && end > start);
  const gatedRow = { hidden: true };
  const metaRow = { hidden: true };
  const nodes = {};
  for (const name of ['accountEmail', 'accountTier', 'accountExpiry', 'accountUsage', 'accountCenter', 'accountLogout', 'accountUpgrade', 'enabled']) {
    nodes[name] = {
      textContent: '', title: '', hidden: false,
      classList: { remove() {}, add() {} },
    };
  }
  const events = [];
  const runtime = vm.createContext({
    document: { querySelectorAll: selector => selector === '[data-entitlement-limit]' ? [gatedRow, metaRow] : [] },
    window: { dispatchEvent: event => events.push(event) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    el: nodes,
    showAppScreen() {},
    localDate(value) { return value || '—'; },
  });
  vm.runInContext(auth.slice(start, end) + '\nglobalThis.paint = renderAccount;', runtime);
  const user = {
    authenticated: true, user: { email: 'test@example.com' },
    entitlement: { active: true, limitsEnabled: false, expiresAt: '2020-01-01', limits: { devices: 1, windows: 1 } },
  };
  runtime.paint(user);
  assert.equal(gatedRow.hidden, true);
  assert.equal(metaRow.hidden, true);
  assert.equal(nodes.accountUpgrade.hidden, true);
  assert.equal(nodes.accountCenter.textContent, '账户中心');
  assert.equal(nodes.accountEmail.textContent, 'test@example.com');
  assert.equal(nodes.enabled.title, 'GPTWork 功能可用');
  assert.equal(events.at(-1).detail.limitsEnabled, false);
  runtime.paint({ ...user, entitlement: { ...user.entitlement, limitsEnabled: true } });
  assert.equal(gatedRow.hidden, false);
  assert.equal(metaRow.hidden, false);
  assert.equal(nodes.accountUpgrade.hidden, false);
  assert.equal(events.at(-1).detail.limitsEnabled, true);
  runtime.paint({ authenticated: false });
  assert.equal(gatedRow.hidden, true);
  assert.equal(metaRow.hidden, true);
  assert.equal(nodes.accountCenter.textContent, '登录 / 注册');
});
