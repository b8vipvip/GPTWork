import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const accountHtml = await readFile(new URL('../../extension/account.html', import.meta.url), 'utf8');
const commerce = await readFile(new URL('../../extension/account-commerce.js', import.meta.url), 'utf8');

test('extension account center exposes account-wide recent membership orders', () => {
  assert.match(accountHtml, /<h2>最近订单<\/h2>/);
  assert.match(accountHtml, /id="recentOrders"/);
  assert.match(commerce, /\/api\/v1\/account\/orders\?limit=/);
  assert.match(commerce, /gptlockAccountSessionToken/);
  assert.doesNotMatch(commerce, /gptworkRecentMembershipOrderIds/);
  assert.match(commerce, /GPTLOCK_ACCOUNT_GET_ORDER/);
  assert.match(commerce, /order\.expiresAt/);
  assert.match(commerce, /剩余/);
  assert.match(commerce, /继续支付/);
  assert.match(commerce, /setInterval\(\(\) => \{ if \(!document\.hidden\) void refreshOrders\(\); \}, 10_000\)/);
});

test('expired pending orders stop offering continue payment and reconcile with server', () => {
  assert.match(commerce, /Date\.parse\(order\.expiresAt \|\| ''\) > Date\.now\(\)/);
  assert.match(commerce, /if \(value === '已失效' && row\.querySelector\('button'\)\) needsRefresh = true/);
  assert.match(commerce, /void refreshOrders\(\)/);
});
