import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeWebsiteConfig } from '../website-system.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const websiteAccount = readFileSync(resolve(root, 'license-server/public/account.html'), 'utf8');
const websiteRuntime = readFileSync(resolve(root, 'license-server/public/account-commerce.js'), 'utf8');
const extensionAccount = readFileSync(resolve(root, 'extension/account.html'), 'utf8');
const extensionVisibility = readFileSync(resolve(root, 'extension/account-visibility.js'), 'utf8');
const websiteAdmin = readFileSync(resolve(root, 'license-server/public/admin-website.js'), 'utf8');

function accountModule(config, id) {
  return config.pages.account.modules.find((item) => item.id === id);
}

test('legacy membership plans and recent orders remain default-disabled website config modules', () => {
  const config = normalizeWebsiteConfig({});
  const plans = accountModule(config, 'account-membership-plans');
  const orders = accountModule(config, 'account-recent-orders');
  assert.equal(plans?.name, '会员方案');
  assert.equal(plans?.enabled, false);
  assert.equal(orders?.name, '最近订单');
  assert.equal(orders?.enabled, false);
  assert.match(websiteAdmin, /页面模块启停状态已自动保存并实时生效/);
});

test('website-managed account module switches still persist enabled state for compatibility', () => {
  const config = normalizeWebsiteConfig({
    pages: {
      account: {
        modules: [
          { id: 'account-membership-plans', enabled: true },
          { id: 'account-recent-orders', enabled: true },
        ],
      },
    },
  });
  assert.equal(accountModule(config, 'account-membership-plans')?.enabled, true);
  assert.equal(accountModule(config, 'account-recent-orders')?.enabled, true);
});

test('website upgrade is canonical while optional order history stays server-configured', () => {
  assert.match(websiteAccount, /id="siteUpgrade"/);
  assert.match(websiteAccount, /id="siteUpgradeDialog"/);
  assert.doesNotMatch(websiteAccount, /id="membershipPlansSection"/);
  assert.match(websiteAccount, /id="recentOrdersSection" hidden aria-hidden="true"/);
  assert.match(websiteAccount, /account-commerce\.js/);
  assert.doesNotMatch(websiteAccount, /account-visibility\.js/);
  assert.match(websiteRuntime, /account-recent-orders/);
  assert.match(websiteRuntime, /recentOrders\.hidden = !Boolean\(ordersModule\?\.enabled\)/);
  assert.match(websiteRuntime, /pages\?\.account\?\.modules/);

  assert.match(extensionAccount, /id="membershipPlansSection" hidden aria-hidden="true"/);
  assert.match(extensionAccount, /id="recentOrdersSection" hidden aria-hidden="true"/);
  assert.match(extensionAccount, /account-visibility\.js/);
  assert.match(extensionVisibility, /account-membership-plans/);
  assert.match(extensionVisibility, /account-recent-orders/);
  assert.match(extensionVisibility, /pages\?\.account\?\.modules/);
  assert.match(extensionVisibility, /Boolean\(module\?\.enabled\)/);
  assert.match(extensionVisibility, /https:\/\/gptlock\.mv3\.cn\/site\/api\/website/);
});
