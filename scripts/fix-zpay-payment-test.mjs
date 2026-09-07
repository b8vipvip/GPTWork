import { readFile, writeFile, rm } from 'node:fs/promises';
const path = 'license-server/test/payment-system.test.mjs';
let s = await readFile(path, 'utf8');
function once(before, after, label) {
  const n = s.split(before).length - 1;
  if (n !== 1) throw new Error(`${label}: expected 1 match, got ${n}`);
  s = s.replace(before, after);
}
once(
  "  const payments = createPaymentSystem({ db, publicOrigin: 'https://gptlock.example', json, secret: 'test-secret-at-least-thirty-two-characters-long', logger: { warn() {} } });\n  createRuntimeSchema(db);\n  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL) STRICT; INSERT INTO users(id,email) VALUES(1,'buyer@example.com');`);",
  "  const payments = createPaymentSystem({\n    db, publicOrigin: 'https://gptlock.example', json, secret: 'test-secret-at-least-thirty-two-characters-long', logger: { warn() {} },\n    fetchImpl: async (url) => {\n      assert.equal(String(url), 'https://zpayz.cn/mapi.php');\n      return new Response(JSON.stringify({ code: 1, msg: 'success', O_id: 'ZPAY-ORDER-1', trade_no: 'PREPAY-1', payurl: 'https://pay.example/zpay/checkout', qrcode: 'alipays://platformapi/startapp', img: 'https://pay.example/zpay/qr.png' }), { status: 200, headers: { 'content-type': 'application/json' } });\n    },\n  });\n  createRuntimeSchema(db);\n  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL) STRICT; INSERT INTO users(id,email) VALUES(1,'buyer@example.com');`);",
  'zpay test payment system constructor');
once(
  "  order = payments.prepareOrder(order, { clientIp: '203.0.113.8', userAgent: 'test' });\n  assert.match(order.pay_url, /\\/site\\/api\\/zpay\\/checkout\\//);\n\n  const checkoutRes = responseCapture();\n  await payments.handleSite(request('GET'), checkoutRes, new URL(order.pay_url));\n  assert.equal(checkoutRes.status, 200);\n  const checkoutHtml = checkoutRes.body.toString('utf8');\n  assert.match(checkoutHtml, /action=\"https:\\/\\/zpayz\\.cn\\/submit\\.php\"/);\n  assert.match(checkoutHtml, /name=\"money\" value=\"29\\.00\"/);\n  assert.match(checkoutHtml, /name=\"cid\" value=\"1234\"/);\n\n  const detail = payments.zpayOrderDetails(order.id);",
  "  order = await payments.prepareOrder(order, { clientIp: '203.0.113.8', userAgent: 'test' });\n  assert.equal(order.pay_url, 'https://pay.example/zpay/checkout');\n\n  const detail = payments.zpayOrderDetails(order.id);\n  assert.equal(detail.orderNo, 'ZPAY-ORDER-1');\n  assert.equal(detail.payUrl, 'https://pay.example/zpay/checkout');\n  assert.equal(detail.qrImageUrl, 'https://pay.example/zpay/qr.png');\n  assert.equal(detail.qrPayload, 'alipays://platformapi/startapp');",
  'zpay direct checkout assertions');
await writeFile(path, s, 'utf8');
await rm('scripts/fix-zpay-payment-test.mjs', { force: true });
await rm('.github/workflows/fix-zpay-payment-test.yml', { force: true });
console.log('ZPAY payment-system regression test updated');
