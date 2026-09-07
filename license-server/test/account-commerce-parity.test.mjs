import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePlanPricing } from '../plan-pricing.mjs';

const websiteCommerce = await readFile(new URL('../public/account-commerce.js', import.meta.url), 'utf8');
const extensionCommerce = await readFile(new URL('../../extension/account-commerce.js', import.meta.url), 'utf8');
const paymentSystem = await readFile(new URL('../payment-system.mjs', import.meta.url), 'utf8');
const accountSystem = await readFile(new URL('../account-system.mjs', import.meta.url), 'utf8');
const zpayClient = await readFile(new URL('../zpay-client.mjs', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

test('promotion expires back to original price without fake urgency', () => {
  const now = Date.parse('2026-09-07T08:00:00Z');
  const active = normalizePlanPricing({ price_cents: 2900, original_price_cents: 2900, promo_price_cents: 1900, promo_ends_at: '2026-09-08T08:00:00Z' }, now);
  assert.equal(active.priceCents, 1900);
  assert.equal(active.promoActive, true);
  assert.equal(active.savingsCents, 1000);
  const expired = normalizePlanPricing({ price_cents: 2900, original_price_cents: 2900, promo_price_cents: 1900, promo_ends_at: '2026-09-06T08:00:00Z' }, now);
  assert.equal(expired.priceCents, 2900);
  assert.equal(expired.promoActive, false);
});

test('website and extension expose the same checkout UX contract', () => {
  for (const source of [websiteCommerce, extensionCommerce]) {
    assert.match(source, /恢复原价剩余时间/);
    assert.match(source, /textContent = '开通'/);
    assert.match(source, /微信支付/);
    assert.doesNotMatch(source, /微信支付（ZPAY）|支付宝（ZPAY）/);
    assert.match(source, /GET_ORDER|site\/api\/account\/orders/);
    assert.match(source, /qrImageUrl/);
    assert.match(source, /扫码完成支付/);
  }
});

test('direct ZPAY QR metadata is produced server-side and exposed to extension account API', () => {
  assert.match(zpayClient, /mapi\.php/);
  assert.match(zpayClient, /FormData/);
  assert.match(paymentSystem, /createPayment\(params\)/);
  assert.match(paymentSystem, /qr_image_url/);
  assert.match(paymentSystem, /qrPayload/);
  assert.match(accountSystem, /paymentSystem\.zpayOrderDetails\(row\.id\)/);
});

test('production ZPAY checkout keeps HTTPS handoff fallback while allowing direct QR images', () => {
  assert.match(paymentSystem, /form-action https:/);
  assert.match(paymentSystem, /frame-ancestors 'self'/);
  assert.match(paymentSystem, /x-frame-options': 'SAMEORIGIN'/);
  assert.match(server, /frame-src 'self' https:/);
  assert.match(server, /img-src 'self' data: https:/);
});
