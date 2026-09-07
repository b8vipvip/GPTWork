import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createPaymentSystem } from '../payment-system.mjs';

function request(method, body = null) {
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  return req;
}
function responseCapture() {
  return {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(payload = Buffer.alloc(0)) { this.body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)); },
  };
}
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function legacyDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE payment_methods (
      code TEXT PRIMARY KEY CHECK(code IN ('wechat','alipay')),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      pay_url TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE membership_orders (
      id INTEGER PRIMARY KEY,
      payment_method TEXT NOT NULL REFERENCES payment_methods(code)
    ) STRICT;
    INSERT INTO payment_methods(code,name,enabled,pay_url,instructions,updated_at)
      VALUES('wechat','微信支付',1,'','legacy','2026-09-03T00:00:00.000Z');
    INSERT INTO membership_orders(id,payment_method) VALUES(1,'wechat');
  `);
  return db;
}

function paymentRuntimeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  return db;
}

function createRuntimeSchema(db) {
  db.exec(`
    CREATE TABLE membership_plans (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      duration_days INTEGER NOT NULL,
      max_devices INTEGER NOT NULL,
      max_windows INTEGER NOT NULL,
      benefits_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE membership_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan_code TEXT NOT NULL REFERENCES membership_plans(code),
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
    INSERT INTO membership_plans(code,name,price_cents,duration_days,max_devices,max_windows,benefits_json,enabled,sort_order,created_at,updated_at)
      VALUES('monthly','月卡',2900,30,2,10,'[]',1,10,'2026-09-03T00:00:00.000Z','2026-09-03T00:00:00.000Z');
  `);
}

test('migrates legacy payment method constraint and preserves foreign keys', () => {
  const db = legacyDb();
  const payments = createPaymentSystem({ db, publicOrigin: 'https://gptlock.example', json });
  const codes = payments.list(false).map((row) => row.code);
  assert.deepEqual(codes, ['wechat', 'alipay', 'usdt']);
  assert.equal(db.prepare("SELECT instructions FROM payment_methods WHERE code='wechat'").get().instructions, 'legacy');
  assert.equal(db.prepare('SELECT payment_method FROM membership_orders WHERE id=1').get().payment_method, 'wechat');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('saves USDT link/network and serves uploaded QR', async () => {
  const db = legacyDb();
  const payments = createPaymentSystem({ db, publicOrigin: 'https://gptlock.example', json });

  const putRes = responseCapture();
  const putHandled = await payments.handleAdmin(request('PUT', {
    enabled: true,
    payUrl: 'https://www.okx.com/example-payment',
    instructions: 'Pay exact amount shown in the order.',
    crypto: { asset: 'USDT', network: 'USDT-TRC20', address: 'TExampleAddress', memo: '' },
  }), putRes, new URL('https://gptlock.example/admin/api/payments/usdt'));
  assert.equal(putHandled, true);
  assert.equal(putRes.status, 200);
  const usdt = payments.list(false).find((row) => row.code === 'usdt');
  assert.equal(usdt.enabled, true);
  assert.equal(usdt.crypto.network, 'USDT-TRC20');
  assert.equal(usdt.crypto.address, 'TExampleAddress');

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const uploadRes = responseCapture();
  await payments.handleAdmin(request('POST', { dataUrl: `data:image/png;base64,${png.toString('base64')}` }), uploadRes,
    new URL('https://gptlock.example/admin/api/payments/wechat/qr'));
  assert.equal(uploadRes.status, 200);
  const wechat = payments.list(false).find((row) => row.code === 'wechat');
  assert.equal(wechat.qrConfigured, true);
  assert.equal(wechat.payUrl, 'https://gptlock.example/site/api/payment-qr/wechat');

  const qrRes = responseCapture();
  const qrReq = request('GET');
  const qrHandled = await payments.handleSite(qrReq, qrRes, new URL('https://gptlock.example/site/api/payment-qr/wechat'));
  assert.equal(qrHandled, true);
  assert.equal(qrRes.status, 200);
  assert.equal(qrRes.headers['content-type'], 'image/png');
  assert.deepEqual(qrRes.body, png);
  payments.close();
  db.close();
});

test('freezes unique USDT amounts and settles only final successful exact OKX deposits', async () => {
  const db = paymentRuntimeDb();
  let depositRows = [];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() { return { code: '0', msg: '', data: depositRows }; },
  });
  const payments = createPaymentSystem({
    db,
    publicOrigin: 'https://gptlock.example',
    json,
    secret: 'test-secret-at-least-thirty-two-characters-long',
    fetchImpl,
    logger: { warn() {} },
  });
  createRuntimeSchema(db);

  let res = responseCapture();
  await payments.handleAdmin(request('PUT', {
    enabled: true,
    payUrl: 'https://www.okx.com/pay/example',
    crypto: { asset: 'USDT', network: 'USDT-TRC20', address: 'TExampleAddress', memo: '' },
  }), res, new URL('https://gptlock.example/admin/api/payments/usdt'));
  assert.equal(res.status, 200);

  res = responseCapture();
  await payments.handleAdmin(request('PUT', { prices: { monthly: '4.5' } }), res,
    new URL('https://gptlock.example/admin/api/payments/usdt/prices'));
  assert.equal(res.status, 200);

  res = responseCapture();
  await payments.handleAdmin(request('PUT', {
    enabled: true,
    apiKey: 'read-key',
    secretKey: 'read-secret',
    passphrase: 'read-passphrase',
    pollSeconds: 300,
    orderTtlMinutes: 120,
    allowInternalTransfers: true,
  }), res, new URL('https://gptlock.example/admin/api/payments/usdt/okx'));
  assert.equal(res.status, 200);

  const now = Date.now();
  const createdAt = new Date(now - 1_000).toISOString();
  const expiresAt = new Date(now + 60 * 60 * 1000).toISOString();
  const insert = db.prepare(`INSERT INTO membership_orders(user_id,plan_code,payment_method,amount_cents,status,pay_url,created_at,expires_at,plan_snapshot_json)
    VALUES(1,'monthly','usdt',2900,'pending','https://www.okx.com/pay/example',?,?, '{}')`);
  const id1 = Number(insert.run(createdAt, expiresAt).lastInsertRowid);
  const id2 = Number(insert.run(createdAt, expiresAt).lastInsertRowid);
  payments.attachUsdtOrder(id1, payments.usdtQuote('monthly'));
  payments.attachUsdtOrder(id2, payments.usdtQuote('monthly'));
  const p1 = payments.orderPaymentDetails(id1);
  const p2 = payments.orderPaymentDetails(id2);
  assert.equal(p1.amount, '4.5');
  assert.equal(p2.amount, '4.500001');

  const settled = [];
  payments.attachSettlement((orderId, context) => {
    settled.push({ orderId, context });
    db.prepare("UPDATE membership_orders SET status='paid',paid_at=? WHERE id=? AND status='pending'").run(new Date().toISOString(), orderId);
  });
  payments.close();

  depositRows = [{
    ccy: 'USDT', chain: 'USDT-TRC20', amt: p1.amount, to: 'TExampleAddress', txId: 'tx-1', depId: 'dep-1',
    ts: String(now), state: '1', type: '4', actualDepBlkConfirm: '20',
  }];
  let check = await payments.runAutoSettlement({ force: true });
  assert.equal(check.settled, 0);
  assert.equal(settled.length, 0);
  assert.equal(payments.orderPaymentDetails(id1).matchStatus, 'confirming');
  assert.equal(db.prepare('SELECT status FROM membership_orders WHERE id=?').get(id1).status, 'pending');

  depositRows[0] = { ...depositRows[0], state: '2' };
  check = await payments.runAutoSettlement({ force: true });
  assert.equal(check.settled, 1);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].orderId, id1);
  assert.equal(settled[0].context.depositId, 'dep-1');
  assert.equal(payments.orderPaymentDetails(id1).matchStatus, 'settled');
  assert.equal(db.prepare('SELECT status FROM membership_orders WHERE id=?').get(id1).status, 'paid');
  assert.equal(db.prepare('SELECT status FROM membership_orders WHERE id=?').get(id2).status, 'pending');

  depositRows = [{
    ccy: 'USDT', chain: 'USDT-TRC20', amt: p2.amount, to: 'TExampleAddress', txId: 'tx-2', depId: 'dep-2',
    ts: String(now + 1_000), state: '2', type: '4', actualDepBlkConfirm: '20',
  }];
  check = await payments.runAutoSettlement({ force: true });
  assert.equal(check.settled, 1);
  assert.equal(settled.length, 2);
  assert.equal(settled[1].orderId, id2);
  assert.equal(db.prepare('SELECT status FROM membership_orders WHERE id=?').get(id2).status, 'paid');

  payments.close();
  db.close();
});


test('ZPAY checkout signs order-specific POST and settles only an exact verified callback', async () => {
  const db = paymentRuntimeDb();
  const payments = createPaymentSystem({
    db, publicOrigin: 'https://gptlock.example', json, secret: 'test-secret-at-least-thirty-two-characters-long', logger: { warn() {} },
    fetchImpl: async (url) => {
      assert.equal(String(url), 'https://zpayz.cn/mapi.php');
      return new Response(JSON.stringify({ code: 1, msg: 'success', O_id: 'ZPAY-ORDER-1', trade_no: 'PREPAY-1', payurl: 'https://pay.example/zpay/checkout', qrcode: 'alipays://platformapi/startapp', img: 'https://pay.example/zpay/qr.png' }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  createRuntimeSchema(db);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL) STRICT; INSERT INTO users(id,email) VALUES(1,'buyer@example.com');`);

  let res = responseCapture();
  await payments.handleAdmin(request('PUT', { enabled: true, pid: '10001', key: 'merchant-secret', alipayCid: '1234' }), res,
    new URL('https://gptlock.example/admin/api/payments/zpay'));
  assert.equal(res.status, 200);
  res = responseCapture();
  await payments.handleAdmin(request('PUT', { enabled: true, provider: 'zpay', instructions: 'ZPAY 自动确认' }), res,
    new URL('https://gptlock.example/admin/api/payments/alipay'));
  assert.equal(res.status, 200);
  assert.equal(payments.list(true).find((row) => row.code === 'alipay').provider, 'zpay');

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const result = db.prepare(`INSERT INTO membership_orders(user_id,plan_code,payment_method,amount_cents,status,pay_url,created_at,expires_at,plan_snapshot_json)
    VALUES(1,'monthly','alipay',2900,'pending','',?,?,?)`).run(createdAt, expiresAt, JSON.stringify({ code: 'monthly', name: '月卡' }));
  let order = db.prepare('SELECT * FROM membership_orders WHERE id=?').get(Number(result.lastInsertRowid));
  order = await payments.prepareOrder(order, { clientIp: '203.0.113.8', userAgent: 'test' });
  assert.equal(order.pay_url, 'https://pay.example/zpay/checkout');

  const detail = payments.zpayOrderDetails(order.id);
  assert.equal(detail.orderNo, 'ZPAY-ORDER-1');
  assert.equal(detail.payUrl, 'https://pay.example/zpay/checkout');
  assert.equal(detail.qrImageUrl, 'https://pay.example/zpay/qr.png');
  assert.equal(detail.qrPayload, 'alipays://platformapi/startapp');
  const settled = [];
  payments.attachSettlement((orderId, context) => {
    settled.push({ orderId, context });
    db.prepare("UPDATE membership_orders SET status='paid',paid_at=? WHERE id=? AND status='pending'").run(new Date().toISOString(), orderId);
  });
  payments.close();

  const callback = new URL('https://gptlock.example/site/api/zpay/notify');
  const params = {
    pid: '10001', name: 'GPTWork 月卡 会员服务', money: '29.00', out_trade_no: detail.merchantTradeNo,
    trade_no: 'ZPAY-TRADE-1', param: `order-${order.id}`, trade_status: 'TRADE_SUCCESS', type: 'alipay', sign_type: 'MD5',
  };
  const { zpaySign } = await import('../zpay-client.mjs');
  params.sign = zpaySign(params, 'merchant-secret');
  for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
  const notifyRes = responseCapture();
  await payments.handleSite(request('GET'), notifyRes, callback);
  assert.equal(notifyRes.status, 200);
  assert.equal(notifyRes.body.toString(), 'success');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].context.source, 'zpay_auto');
  assert.equal(payments.zpayOrderDetails(order.id).status, 'settled');

  const duplicateRes = responseCapture();
  await payments.handleSite(request('GET'), duplicateRes, callback);
  assert.equal(duplicateRes.body.toString(), 'success');
  assert.equal(settled.length, 1);

  const tampered = new URL(callback);
  tampered.searchParams.set('money', '0.01');
  const badRes = responseCapture();
  await payments.handleSite(request('GET'), badRes, tampered);
  assert.equal(badRes.status, 400);
  assert.equal(badRes.body.toString(), 'fail');
  db.close();
});
