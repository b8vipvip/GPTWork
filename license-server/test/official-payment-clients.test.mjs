import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv,
  createSign,
  generateKeyPairSync,
} from 'node:crypto';
import {
  createAlipayClient,
  createPayPalClient,
  createWechatPayClient,
  officialPaymentInternals,
} from '../official-payment-clients.mjs';

function rsaKeys() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}
function jsonResponse(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(value); },
  };
}

test('Alipay page-pay parameters use RSA2 and notifications verify against the configured Alipay public key', () => {
  const merchant = rsaKeys();
  const alipay = rsaKeys();
  const client = createAlipayClient({
    appId: '2026000000000001',
    appPrivateKeyPem: merchant.privateKey,
    alipayPublicKeyPem: alipay.publicKey,
  });
  const form = client.createPagePayForm({
    outTradeNo: 'GW1001',
    subject: 'GPTWork 月卡',
    totalAmount: 19,
    notifyUrl: 'https://example.com/notify',
    returnUrl: 'https://example.com/return',
  });
  assert.equal(form.gateway, 'https://openapi.alipay.com/gateway.do');
  assert.equal(form.params.method, 'alipay.trade.page.pay');
  assert.equal(form.params.sign_type, 'RSA2');
  assert.ok(form.params.sign.length > 100);

  const notice = {
    app_id: '2026000000000001',
    out_trade_no: 'GW1001',
    trade_no: 'ALI10001',
    trade_status: 'TRADE_SUCCESS',
    total_amount: '19.00',
    sign_type: 'RSA2',
  };
  const signer = createSign('RSA-SHA256');
  signer.update(officialPaymentInternals.alipayCanonical(notice), 'utf8');
  signer.end();
  notice.sign = signer.sign(alipay.privateKey, 'base64');
  assert.equal(client.verifyNotification(notice).trade_no, 'ALI10001');
  assert.throws(() => client.verifyNotification({ ...notice, total_amount: '20.00' }), /签名验证失败/);
});

test('PayPal client obtains OAuth token, creates Orders v2 checkout and captures it', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/oauth2/token')) return jsonResponse(200, { access_token: 'token-1' });
    if (url.endsWith('/v2/checkout/orders')) return jsonResponse(201, {
      id: 'PAYPAL-1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.paypal.com/checkoutnow?token=PAYPAL-1' }],
    });
    if (url.endsWith('/v2/checkout/orders/PAYPAL-1/capture')) return jsonResponse(201, {
      id: 'PAYPAL-1', status: 'COMPLETED', purchase_units: [{ reference_id: 'order-42', payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'CNY', value: '19.00' } }] } }],
    });
    throw new Error(`unexpected ${url}`);
  };
  const client = createPayPalClient({ clientId: 'client', clientSecret: 'secret', currency: 'CNY', sandbox: true, fetchImpl });
  const created = await client.createOrder({ referenceId: 'order-42', description: 'GPTWork', amountCents: 1900,
    returnUrl: 'https://example.com/return', cancelUrl: 'https://example.com/cancel' });
  assert.equal(created.providerOrderId, 'PAYPAL-1');
  assert.match(created.payUrl, /^https:\/\/www\.paypal\.com/);
  const createCall = calls.find((item) => item.url.endsWith('/v2/checkout/orders'));
  const createBody = JSON.parse(createCall.options.body);
  assert.equal(createBody.intent, 'CAPTURE');
  assert.equal(createBody.purchase_units[0].amount.currency_code, 'CNY');
  assert.equal(createBody.purchase_units[0].amount.value, '19.00');
  const captured = await client.captureOrder('PAYPAL-1');
  assert.equal(captured.status, 'COMPLETED');
});

test('WeChat Pay client signs H5 requests and verifies/decrypts API v3 payment notifications', async () => {
  const merchant = rsaKeys();
  const platform = rsaKeys();
  const apiV3Key = '12345678901234567890123456789012';
  let requestCall = null;
  const fetchImpl = async (url, options = {}) => {
    requestCall = { url, options };
    return jsonResponse(200, { h5_url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx123' });
  };
  const client = createWechatPayClient({
    appId: 'wx-app-id', mchId: '1900000109', merchantSerialNo: 'MERCHANT-SERIAL', merchantPrivateKeyPem: merchant.privateKey,
    apiV3Key, platformSerialNo: 'PLATFORM-SERIAL', platformPublicKeyPem: platform.publicKey, fetchImpl,
  });
  const created = await client.createH5Order({ description: 'GPTWork 月卡', outTradeNo: 'GW1001',
    notifyUrl: 'https://example.com/wechat/notify', totalCents: 1900, clientIp: '203.0.113.4' });
  assert.match(created.payUrl, /^https:\/\/wx\.tenpay\.com/);
  assert.equal(requestCall.url, 'https://api.mch.weixin.qq.com/v3/pay/transactions/h5');
  assert.match(requestCall.options.headers.authorization, /^WECHATPAY2-SHA256-RSA2048 /);
  const requestBody = JSON.parse(requestCall.options.body);
  assert.equal(requestBody.amount.total, 1900);
  assert.equal(requestBody.scene_info.payer_client_ip, '203.0.113.4');

  const transaction = { mchid: '1900000109', appid: 'wx-app-id', out_trade_no: 'GW1001', transaction_id: 'WX-TXN-1', trade_state: 'SUCCESS', amount: { total: 1900, currency: 'CNY' } };
  const nonce = '123456789012';
  const aad = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const rawBody = JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', resource: { ciphertext, nonce, associated_data: aad } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const noticeNonce = 'notice-nonce';
  const signer = createSign('RSA-SHA256');
  signer.update(`${timestamp}\n${noticeNonce}\n${rawBody}\n`, 'utf8');
  signer.end();
  const headers = {
    'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': noticeNonce,
    'wechatpay-signature': signer.sign(platform.privateKey, 'base64'),
    'wechatpay-serial': 'PLATFORM-SERIAL',
  };
  const notice = client.verifyNotification(headers, rawBody);
  assert.equal(notice.transaction.trade_state, 'SUCCESS');
  assert.equal(notice.transaction.transaction_id, 'WX-TXN-1');
});
