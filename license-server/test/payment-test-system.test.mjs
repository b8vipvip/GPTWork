import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPaymentTestSystem, paymentTestInternals } from '../payment-test-system.mjs';
import { zpaySign } from '../zpay-client.mjs';

function encryptLegacy(secret, keyName, value) {
  const key = createHmac('sha256', secret).update('gptlock-okx-payment-settings:v1').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`gptlock-okx-setting:v1:${keyName}`));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function createDb(secret) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE secure_settings (key TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE payment_methods (code TEXT PRIMARY KEY, pay_url TEXT NOT NULL DEFAULT '') STRICT;
    CREATE TABLE payment_method_details (code TEXT PRIMARY KEY, crypto_network TEXT NOT NULL DEFAULT '', crypto_address TEXT NOT NULL DEFAULT '', crypto_memo TEXT NOT NULL DEFAULT '') STRICT;
  `);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('zpay_pid', '2026090409043752', now);
  db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('zpay_wechat_cid', '23533', now);
  db.prepare('INSERT INTO secure_settings(key,ciphertext,updated_at) VALUES(?,?,?)').run('zpay_key', encryptLegacy(secret, 'zpay_key', 'merchant-secret'), now);
  db.prepare('INSERT INTO payment_methods(code,pay_url) VALUES(?,?)').run('usdt', '');
  db.prepare('INSERT INTO payment_method_details(code) VALUES(?)').run('usdt');
  return db;
}

function captureResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(value = '') { this.body += Buffer.isBuffer(value) ? value.toString('utf8') : String(value); },
  };
}

test('payment test helpers keep exact 0.01 units', () => {
  assert.equal(paymentTestInternals.decimalToCents('0.01'), 1);
  assert.equal(paymentTestInternals.decimalToMicros('0.01'), 10_000);
  assert.equal(paymentTestInternals.decimalToCents('0.001'), null);
});

test('ZPAY real test order creates a 0.01 checkout and settles only the test order', async () => {
  const secret = 's'.repeat(40);
  const db = createDb(secret);
  const system = createPaymentTestSystem({
    db,
    publicOrigin: 'https://gptwork.example',
    secret,
    clientIp: () => '203.0.113.10',
    fetchImpl: async () => { throw new Error('network should not be used for ZPAY form test'); },
  });

  const order = await system.createTestOrder('zpay-wechat', { headers: {}, socket: {} });
  assert.equal(order.provider, 'zpay_wechat');
  assert.equal(order.amount, '0.01');
  assert.equal(order.currency, 'CNY');
  assert.equal(order.grantsMembership, false);
  assert.match(order.merchantTradeNo, /^\d{20,32}$/);
  assert.equal(order.payUrl, `https://gptwork.example/site/api/payment-tests/${order.id}/checkout`);

  const checkoutRes = captureResponse();
  const handled = await system.handleSite(
    { method: 'GET', headers: {}, socket: {} },
    checkoutRes,
    new URL(order.payUrl),
  );
  assert.equal(handled, true);
  assert.equal(checkoutRes.status, 200);
  assert.equal(
    checkoutRes.headers['content-security-policy'],
    "default-src 'none'; script-src 'unsafe-inline'; form-action https:; base-uri 'none'; frame-ancestors 'none'",
  );
  assert.match(checkoutRes.body, /https:\/\/zpayz\.cn\/submit\.php/);
  assert.match(checkoutRes.body, /name="money" value="0\.01"/);
  assert.match(checkoutRes.body, /name="cid" value="23533"/);
  assert.match(checkoutRes.body, /payment-tests\/zpay\/notify/);

  const callback = new URLSearchParams({
    pid: '2026090409043752',
    type: 'wxpay',
    out_trade_no: order.merchantTradeNo,
    trade_no: 'ZP202609070001',
    money: '0.01',
    trade_status: 'TRADE_SUCCESS',
  });
  callback.set('sign', zpaySign(callback, 'merchant-secret'));
  callback.set('sign_type', 'MD5');
  const notifyRes = captureResponse();
  await system.handleSite(
    { method: 'GET', headers: {}, socket: {} },
    notifyRes,
    new URL(`https://gptwork.example/site/api/payment-tests/zpay/notify?${callback}`),
  );
  assert.equal(notifyRes.status, 200);
  assert.equal(notifyRes.body, 'success');

  const settled = await system.getTestOrder(order.id);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.providerTradeNo, 'ZP202609070001');
  assert.equal(settled.grantsMembership, false);
  db.close();
});
