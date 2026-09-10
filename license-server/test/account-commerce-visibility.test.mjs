import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeWebsiteConfig } from '../website-system.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const websiteAccount = readFileSync(resolve(root, 'license-server/public/account.html'), 'utf8');
const websiteVisibility = readFileSync(resolve(root, 'license-server/public/account-visibility.js'), 'utf8');
const extensionAccount = readFileSync(resolve(root, 'extension/account.html'), 'utf8');
const extensionVisibility = readFileSync(resolve(root, 'extension/account-visibility.js'), 'utf8');
const websiteAdmin = readFileSync(resolve(root, 'license-server/public/admin-website.js'), 'utf8');

function accountModule(config, id) {
  return config.pages.account.modules.find((item) => item.id === id);
}

test('membership plans and recent orders default to disabled website-managed account modules', () => {
  const config = normalizeWebsiteConfig({});
  const plans = accountModule(config, 'account-membership-plans');
  const orders = accountModule(config, 'account-recent-orders');
  assert.equal(plans?.name, '会员方案');
  assert.equal(plans?.enabled, false);
  assert.equal(orders?.name, '最近订单');
  assert.equal(orders?.enabled, false);
  assert.match(websiteAdmin, /页面模块启停状态已自动保存并实时生效/);
});

test('website-managed account module switches persist enabled state', () => {
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

test('website and extension commerce sections fail closed and follow the same server switches', () => {
  for (const html of [websiteAccount, extensionAccount]) {
    assert.match(html, /id="membershipPlansSection" hidden aria-hidden="true"/);
    assert.match(html, /id="recentOrdersSection" hidden aria-hidden="true"/);
    assert.match(html, /account-visibility\.js/);
  }
  for (const script of [websiteVisibility, extensionVisibility]) {
    assert.match(script, /account-membership-plans/);
    assert.match(script, /account-recent-orders/);
    assert.match(script, /pages\?\.account\?\.modules/);
    assert.match(script, /Boolean\(module\?\.enabled\)/);
  }
  assert.match(websiteVisibility, /\/site\/api\/website/);
  assert.match(extensionVisibility, /https:\/\/gptlock\.mv3\.cn\/site\/api\/website/);
});
