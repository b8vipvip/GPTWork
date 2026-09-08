import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createAccountOrdersApi } from '../account-orders.mjs';

function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE user_sessions (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT NOT NULL
    );
    CREATE TABLE membership_plans (
      code TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL,
      duration_days INTEGER NOT NULL, max_devices INTEGER NOT NULL, max_windows INTEGER NOT NULL,
      benefits_json TEXT NOT NULL
    );
    CREATE TABLE membership_orders (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, plan_code TEXT NOT NULL,
      payment_method TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL,
      pay_url TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      paid_at TEXT, membership_id INTEGER, plan_snapshot_json TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO users(id,status) VALUES(?,?)').run(1, 'active');
  db.prepare('INSERT INTO users(id,status) VALUES(?,?)').run(2, 'active');
  db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,expires_at,last_seen_at) VALUES(?,?,?,?,?)')
    .run(10, 1, hash('token-user-1'), '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO membership_plans VALUES(?,?,?,?,?,?,?)')
    .run('monthly', '月卡 / Monthly', 1900, 30, 3, 3, JSON.stringify(['30 天会员有效期']));
  const snapshot = JSON.stringify({
    code: 'monthly', name: '月卡 / Monthly', priceCents: 1900, durationDays: 30,
    maxDevices: 3, maxWindows: 3, benefits: ['30 天会员有效期'],
  });
  const insert = db.prepare(`INSERT INTO membership_orders
    (id,user_id,plan_code,payment_method,amount_cents,status,pay_url,created_at,expires_at,paid_at,membership_id,plan_snapshot_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(1, 1, 'monthly', 'wechat', 1900, 'pending', 'https://pay.example/1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z', null, null, snapshot);
  insert.run(2, 1, 'monthly', 'wechat', 1900, 'paid', 'https://pay.example/2', '2026-01-02T00:00:00.000Z', '2026-01-02T00:30:00.000Z', '2026-01-02T00:05:00.000Z', 22, snapshot);
  insert.run(3, 1, 'monthly', 'usdt', 1900, 'pending', '', '2026-01-03T00:00:00.000Z', '2026-01-03T00:30:00.000Z', null, null, snapshot);
  insert.run(4, 2, 'monthly', 'wechat', 1900, 'paid', 'https://pay.example/4', '2026-01-04T00:00:00.000Z', '2026-01-04T00:30:00.000Z', '2026-01-04T00:05:00.000Z', 44, snapshot);
  return db;
}

function responseCapture() {
  return { status: 0, body: null, headers: null };
}

function json(res, status, body, headers = {}) {
  res.status = status;
  res.body = body;
  res.headers = headers;
}

test('account-wide order list returns only the authenticated users latest orders', async () => {
  const db = fixture();
  const paymentSystem = {
    orderPaymentDetails(id) { return { amount: `${id}.000000`, network: 'TRC20' }; },
    zpayOrderDetails(id) { return { qrImageUrl: `https://qr.example/${id}.png` }; },
  };
  const api = createAccountOrdersApi({ db, json, paymentSystem });
  const res = responseCapture();
  const handled = await api.handleApi(
    { method: 'GET', headers: { authorization: 'Bearer token-user-1' } },
    res,
    new URL('https://gptlock.mv3.cn/api/v1/account/orders?limit=20'),
    { 'access-control-allow-origin': 'chrome-extension://example' },
  );

  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.orders.map((item) => item.id), [3, 2, 1]);
  assert.equal(res.body.orders.some((item) => item.id === 4), false);
  assert.equal(res.body.orders.find((item) => item.id === 1).status, 'expired');
  assert.equal(res.body.orders.find((item) => item.id === 3).status, 'pending');
  assert.equal(res.body.orders.find((item) => item.id === 2).planSnapshot.name, '月卡 / Monthly');
  assert.equal(res.body.orders.find((item) => item.id === 1).payment.qrImageUrl, 'https://qr.example/1.png');
  assert.equal(res.body.orders.find((item) => item.id === 3).payment.network, 'TRC20');
  assert.equal(res.headers['access-control-allow-origin'], 'chrome-extension://example');
});

test('account-wide order list rejects a missing or invalid bearer session', async () => {
  const api = createAccountOrdersApi({ db: fixture(), json });
  const res = responseCapture();
  await api.handleApi(
    { method: 'GET', headers: { authorization: 'Bearer wrong-token' } },
    res,
    new URL('https://gptlock.mv3.cn/api/v1/account/orders'),
  );
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'AUTH_REQUIRED');
});

test('extension recent orders use server account history instead of device-local order ids', async () => {
  const commerce = await readFile(new URL('../../extension/account-commerce.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(commerce, /\/api\/v1\/account\/orders\?limit=/);
  assert.match(commerce, /gptlockAccountSessionToken/);
  assert.doesNotMatch(commerce, /gptworkRecentMembershipOrderIds|ORDER_HISTORY_KEY|persistOrderIds|loadOrderIds/);
  assert.match(commerce, /state\.orderRefresh = setInterval/);
  assert.match(server, /createAccountOrdersApi/);
  assert.match(server, /accountOrdersApi\.handleApi/);
});
