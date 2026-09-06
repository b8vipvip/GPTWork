import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createPaymentSystem } from '../payment-system.mjs';
import { createOfficialPaymentSystem } from '../official-payment-system.mjs';
import { composePaymentSystems } from '../composite-payment-system.mjs';

function request(method, body = null) {
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = {};
  return req;
}
function responseCapture() {
  return {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(payload = Buffer.alloc(0)) { this.body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)); },
    json() { return JSON.parse(this.body.toString('utf8') || '{}'); },
  };
}
function json(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length, ...headers });
  res.end(payload);
}
function baseDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  return db;
}
function runtimeOrders(db) {
  db.exec(`
    CREATE TABLE membership_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan_code TEXT NOT NULL,
      payment_method TEXT NOT NULL REFERENCES payment_methods(code),
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','paid','cancelled','expired')),
      pay_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      paid_at TEXT,
      membership_id INTEGER,
      plan_snapshot_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;
  `);
}

const SECRET = 'official-payment-system-test-secret-at-least-32-chars';

test('official payment layer migrates PayPal and hides incomplete official methods from public checkout', async () => {
  const db = baseDb();
  const legacy = createPaymentSystem({ db, publicOrigin: 'https://gptwork.example', json, secret: SECRET, logger: { warn() {} } });
  const official = createOfficialPaymentSystem({ db, publicOrigin: 'https://gptwork.example', secret: SECRET, logger: { warn() {} }, fetchImpl: async () => { throw new Error('network not expected'); } });
  const payments = composePaymentSystems(legacy, official);

  assert.deepEqual(payments.list(false).map((row) => row.code), ['wechat', 'alipay', 'usdt', 'paypal']);

  let res = responseCapture();
  await official.handleAdmin(request('PUT', {
    enabled: true,
    provider: 'wechat_official',
    appId: 'wx-test-app',
  }), res, new URL('https://gptwork.example/admin/api/official-payments/wechat'));
  assert.equal(res.status, 200);
  assert.equal(res.json().config.configured, false);
  assert.equal(payments.list(true).some((row) => row.code === 'wechat'), false);

  res = responseCapture();
  await official.handleAdmin(request('PUT', {
    enabled: true,
    clientId: 'paypal-client-id',
    clientSecret: 'paypal-client-secret',
    sandbox: true,
    currency: 'CNY',
    instructions: 'Pay with PayPal official checkout.',
  }), res, new URL('https://gptwork.example/admin/api/official-payments/paypal'));
  assert.equal(res.status, 200);
  const saved = res.json().config;
  assert.equal(saved.configured, true);
  assert.equal(saved.clientSecretConfigured, true);
  assert.equal(Object.hasOwn(saved, 'clientSecret'), false);
  const paypal = payments.list(true).find((row) => row.code === 'paypal');
  assert.equal(paypal.provider, 'paypal_official');
  assert.equal(paypal.autoConfirm, true);
  assert.equal(paypal.payUrl, '');

  payments.close();
  db.close();
});

test('PayPal official prepareOrder creates Orders v2 approval URL and freezes provider order id', async () => {
  const db = baseDb();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/oauth2/token')) return {
      ok: true, status: 200, async text() { return JSON.stringify({ access_token: 'oauth-token' }); },
    };
    if (url.endsWith('/v2/checkout/orders')) return {
      ok: true, status: 201, async text() { return JSON.stringify({
        id: 'PAYPAL-ORDER-100',
        status: 'PAYER_ACTION_REQUIRED',
        links: [{ rel: 'payer-action', href: 'https://www.paypal.com/checkoutnow?token=PAYPAL-ORDER-100' }],
      }); },
    };
    throw new Error(`unexpected request ${url}`);
  };
  const legacy = createPaymentSystem({ db, publicOrigin: 'https://gptwork.example', json, secret: SECRET, logger: { warn() {} } });
  const official = createOfficialPaymentSystem({ db, publicOrigin: 'https://gptwork.example', secret: SECRET, logger: { warn() {} }, fetchImpl });
  const payments = composePaymentSystems(legacy, official);
  runtimeOrders(db);

  let res = responseCapture();
  await official.handleAdmin(request('PUT', {
    enabled: true,
    clientId: 'paypal-client-id',
    clientSecret: 'paypal-client-secret',
    sandbox: true,
    currency: 'CNY',
  }), res, new URL('https://gptwork.example/admin/api/official-payments/paypal'));
  assert.equal(res.status, 200);

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const insert = db.prepare(`INSERT INTO membership_orders(user_id,plan_code,payment_method,amount_cents,status,pay_url,created_at,expires_at,plan_snapshot_json)
    VALUES(1,'monthly','paypal',1900,'pending','',?,?,?)`);
  const orderId = Number(insert.run(createdAt, expiresAt, JSON.stringify({ name: '月卡' })).lastInsertRowid);
  const order = db.prepare('SELECT * FROM membership_orders WHERE id=?').get(orderId);
  const prepared = await payments.prepareOrder(order, { clientIp: '203.0.113.10', userAgent: 'test' });
  assert.equal(prepared.pay_url, 'https://www.paypal.com/checkoutnow?token=PAYPAL-ORDER-100');

  const detail = db.prepare('SELECT * FROM official_payment_orders WHERE order_id=?').get(orderId);
  assert.equal(detail.provider, 'paypal_official');
  assert.equal(detail.provider_order_id, 'PAYPAL-ORDER-100');
  assert.equal(detail.amount_cents, 1900);
  const createCall = calls.find((call) => call.url.endsWith('/v2/checkout/orders'));
  const payload = JSON.parse(createCall.options.body);
  assert.equal(payload.purchase_units[0].reference_id, `order-${orderId}`);
  assert.equal(payload.purchase_units[0].amount.value, '19.00');
  assert.equal(payload.purchase_units[0].amount.currency_code, 'CNY');

  payments.close();
  db.close();
});
