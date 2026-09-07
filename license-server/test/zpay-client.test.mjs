import test from 'node:test';
import assert from 'node:assert/strict';
import { centsFromZpayMoney, createZpayClient, verifyZpaySignature, zpayMoneyFromCents, zpaySign } from '../zpay-client.mjs';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

test('ZPAY MD5 signing follows ASCII key order and excludes sign/sign_type/empty values', () => {
  const params = { type: 'alipay', pid: '10001', money: '19.00', out_trade_no: '202609030001', empty: '', sign_type: 'MD5' };
  const sign = zpaySign(params, 'merchant-secret');
  assert.equal(sign, 'e7f2b486ce8a017d096f0b8c67566556');
  const callback = new URLSearchParams({ ...params, sign, sign_type: 'MD5' });
  assert.equal(verifyZpaySignature(callback, 'merchant-secret'), true);
  callback.set('money', '19.01');
  assert.equal(verifyZpaySignature(callback, 'merchant-secret'), false);
});

test('ZPAY money conversion is exact to cents', () => {
  assert.equal(zpayMoneyFromCents(1900), '19.00');
  assert.equal(centsFromZpayMoney('19'), 1900);
  assert.equal(centsFromZpayMoney('19.0'), 1900);
  assert.equal(centsFromZpayMoney('19.00'), 1900);
  assert.equal(centsFromZpayMoney('19.001'), null);
});

test('ZPAY admin probe uses the documented act=order API instead of an undocumented balance action', async () => {
  let requestedUrl = null;
  const client = createZpayClient({
    pid: '2026090409043752',
    key: 'merchant-secret',
    fetchImpl: async (url) => {
      requestedUrl = new URL(String(url));
      return jsonResponse({ code: -1, msg: '订单号不存在' });
    },
  });

  const result = await client.queryBalance();
  assert.equal(requestedUrl.origin, 'https://zpayz.cn');
  assert.equal(requestedUrl.pathname, '/api.php');
  assert.equal(requestedUrl.searchParams.get('act'), 'order');
  assert.equal(requestedUrl.searchParams.get('pid'), '2026090409043752');
  assert.match(requestedUrl.searchParams.get('out_trade_no') || '', /^\d{32}$/);
  assert.equal(result.code, 1);
  assert.equal(result.balance, '');
  assert.equal(result.probe, 'order');
  assert.equal(result.credentialStatus, 'api_reachable');
});

test('ZPAY admin probe accepts JSON that the gateway wraps inside a JSON string', async () => {
  const client = createZpayClient({
    pid: '2026090409043752',
    key: 'merchant-secret',
    fetchImpl: async () => jsonResponse(JSON.stringify({ code: 0, msg: '订单编号不存在' })),
  });

  const result = await client.probeCredentials();
  assert.equal(result.code, 1);
  assert.equal(result.credentialStatus, 'api_reachable');
  assert.equal(result.msg, '订单编号不存在');
});

test('ZPAY admin probe reports merchant credential failures instead of converting them to a generic HTTP 200 error', async () => {
  const client = createZpayClient({
    pid: 'bad-pid',
    key: 'bad-key',
    fetchImpl: async () => jsonResponse({ code: -1, msg: '商户密钥错误' }),
  });

  await assert.rejects(
    () => client.probeCredentials(),
    (error) => error?.code === 'ZPAY_AUTH_ERROR' && /商户密钥错误/.test(error.message),
  );
});

test('ZPAY queryOrder still requires a successful code=1 response', async () => {
  const client = createZpayClient({
    pid: '10001',
    key: 'merchant-secret',
    fetchImpl: async () => jsonResponse({ code: 1, msg: '查询订单号成功！', out_trade_no: '12345', status: 0 }),
  });

  const result = await client.queryOrder('12345');
  assert.equal(result.out_trade_no, '12345');
  assert.equal(result.status, 0);
});

test('ZPAY non-JSON upstream responses include a useful diagnostic instead of ZPAY API HTTP 200', async () => {
  const client = createZpayClient({
    pid: '10001',
    key: 'merchant-secret',
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '<html>gateway page</html>'; } }),
  });

  await assert.rejects(
    () => client.probeCredentials(),
    (error) => error?.code === 'ZPAY_INVALID_RESPONSE' && /非 JSON 响应/.test(error.message) && /gateway page/.test(error.message),
  );
});


test('ZPAY MAPI creates a direct checkout and exposes QR metadata', async () => {
  let requestedUrl = ''; let requestedInit = null;
  const client = createZpayClient({
    pid: '10001', key: 'merchant-secret',
    fetchImpl: async (url, init) => {
      requestedUrl = String(url); requestedInit = init;
      return jsonResponse({ code: 1, msg: 'success', O_id: '10009', trade_no: 'T20260907', payurl: 'https://pay.example/checkout', payurl2: 'https://pay.example/alt', qrcode: 'weixin://wxpay/example', img: 'https://pay.example/qr.png' });
    },
  });
  const result = await client.createPayment({ type: 'wxpay', out_trade_no: '123', money: '19.00', sign: 'abc', sign_type: 'MD5' });
  assert.equal(requestedUrl, 'https://zpayz.cn/mapi.php');
  assert.equal(requestedInit.method, 'POST');
  assert.equal(requestedInit.body.get('pid'), '10001');
  assert.equal(requestedInit.body.get('type'), 'wxpay');
  assert.equal(result.orderId, '10009');
  assert.equal(result.payUrl, 'https://pay.example/checkout');
  assert.equal(result.qrCode, 'weixin://wxpay/example');
  assert.equal(result.qrImageUrl, 'https://pay.example/qr.png');
});
