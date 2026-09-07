import { createDecipheriv, createHmac } from 'node:crypto';
import { createAlipayClient, createPayPalClient, createWechatPayClient } from './official-payment-clients.mjs';
import { createOkxClient, OKX_DEFAULT_BASE_URL } from './okx-client.mjs';
import { ZPAY_SUBMIT_URL, centsFromZpayMoney, verifyZpaySignature, zpaySign } from './zpay-client.mjs';

const PROVIDERS = new Set(['zpay_wechat', 'zpay_alipay', 'wechat_official', 'alipay_official', 'paypal_official', 'okx_usdt']);
const SLUGS = new Map([
  ['zpay-wechat', 'zpay_wechat'],
  ['zpay-alipay', 'zpay_alipay'],
  ['wechat', 'wechat_official'],
  ['alipay', 'alipay_official'],
  ['paypal', 'paypal_official'],
  ['usdt', 'okx_usdt'],
]);
const TEST_TTL_MS = 60 * 60 * 1000;
const OKX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const OKX_GRACE_MS = 15 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }
function clean(value, max = 2048) { return String(value ?? '').trim().slice(0, max); }
function htmlEscape(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function decimalToMicros(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,9}(?:\.\d{1,6})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  return Number.isSafeInteger(micros) ? micros : null;
}
function decimalToCents(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}
function sameText(left, right) { return clean(left, 512).toLowerCase() === clean(right, 512).toLowerCase(); }
function writeJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}
function writeText(res, status, text) {
  const payload = Buffer.from(String(text), 'utf8');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}
function writeHtml(res, status, html, csp = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'") {
  const payload = Buffer.from(String(html), 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store',
    'content-security-policy': csp, 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}
async function readRaw(req, max = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('支付测试回调内容过大'), { status: 413, code: 'PAYMENT_TEST_BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function createNumericTradeNo() {
  const entropy = String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0');
  return `99${Date.now()}${entropy}`.slice(0, 32);
}
function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

export function createPaymentTestSystem({ db, publicOrigin, secret = '', env = process.env, fetchImpl = globalThis.fetch, clientIp = () => '127.0.0.1', logger = console }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_test_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL CHECK(provider IN ('zpay_wechat','zpay_alipay','wechat_official','alipay_official','paypal_official','okx_usdt')),
      merchant_trade_no TEXT NOT NULL UNIQUE,
      provider_order_id TEXT NOT NULL DEFAULT '',
      provider_trade_no TEXT NOT NULL DEFAULT '',
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      network TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      pay_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'awaiting' CHECK(status IN ('awaiting','settled','cancelled','expired','error')),
      provider_message TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      paid_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_payment_test_status ON payment_test_orders(status,created_at);
  `);

  const legacyKey = secret ? createHmac('sha256', secret).update('gptlock-okx-payment-settings:v1').digest() : null;
  const officialKey = secret ? createHmac('sha256', secret).update('gptwork-official-payments:v1').digest() : null;

  function getSetting(key, fallback = '') {
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    return row ? row.value : fallback;
  }
  function getSecureCiphertext(key) {
    const row = db.prepare('SELECT ciphertext FROM secure_settings WHERE key=?').get(key);
    return row?.ciphertext || '';
  }
  function decryptSecure(value, keyName, family) {
    const key = family === 'official' ? officialKey : legacyKey;
    if (!value || !key) return '';
    try {
      const [version, ivText, tagText, dataText] = String(value).split('.');
      if (version !== 'v1') return '';
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
      const aad = family === 'official' ? `gptwork-official-payment:v1:${keyName}` : `gptlock-okx-setting:v1:${keyName}`;
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
    } catch { return ''; }
  }
  function legacySecure(key) { return decryptSecure(getSecureCiphertext(key), key, 'legacy'); }
  function officialSecure(key) { return decryptSecure(getSecureCiphertext(key), key, 'official'); }

  function zpayConfig() {
    return {
      pid: clean(getSetting('zpay_pid', ''), 128),
      key: legacySecure('zpay_key'),
      alipayCid: clean(getSetting('zpay_alipay_cid', ''), 240),
      wechatCid: clean(getSetting('zpay_wechat_cid', ''), 240),
    };
  }
  function wechatConfig() {
    return {
      appId: clean(getSetting('wechat_official_app_id', ''), 128),
      mchId: clean(getSetting('wechat_official_mch_id', ''), 64),
      merchantSerialNo: clean(getSetting('wechat_official_merchant_serial', ''), 128),
      merchantPrivateKeyPem: officialSecure('wechat_official_merchant_private_key'),
      apiV3Key: officialSecure('wechat_official_api_v3_key'),
      platformSerialNo: clean(getSetting('wechat_official_platform_serial', ''), 128),
      platformPublicKeyPem: officialSecure('wechat_official_platform_public_key'),
    };
  }
  function alipayConfig() {
    return {
      appId: clean(getSetting('alipay_official_app_id', ''), 128),
      appPrivateKeyPem: officialSecure('alipay_official_app_private_key'),
      alipayPublicKeyPem: officialSecure('alipay_official_public_key'),
      sandbox: getSetting('alipay_official_sandbox', '0') === '1',
    };
  }
  function paypalConfig() {
    return {
      clientId: clean(getSetting('paypal_official_client_id', ''), 256),
      clientSecret: officialSecure('paypal_official_client_secret'),
      sandbox: getSetting('paypal_official_sandbox', '1') === '1',
      currency: clean(getSetting('paypal_official_currency', 'CNY'), 3).toUpperCase() || 'CNY',
    };
  }
  function okxConfig() {
    const method = db.prepare(`SELECT p.pay_url,d.crypto_network,d.crypto_address,d.crypto_memo
      FROM payment_methods p LEFT JOIN payment_method_details d ON d.code=p.code WHERE p.code='usdt'`).get() || {};
    return {
      apiKey: legacySecure('okx_api_key'),
      secretKey: legacySecure('okx_secret_key'),
      passphrase: legacySecure('okx_passphrase'),
      allowInternalTransfers: getSetting('okx_allow_internal_transfers', '1') !== '0',
      network: clean(method.crypto_network, 80),
      address: clean(method.crypto_address, 256),
      memo: clean(method.crypto_memo, 160),
      payUrl: clean(method.pay_url, 2048),
    };
  }

  function row(id) { return db.prepare('SELECT * FROM payment_test_orders WHERE id=?').get(Number(id)); }
  function rowByTradeNo(tradeNo) { return db.prepare('SELECT * FROM payment_test_orders WHERE merchant_trade_no=?').get(clean(tradeNo, 32)); }
  function publicRow(input) {
    if (!input) return null;
    return {
      id: input.id,
      provider: input.provider,
      merchantTradeNo: input.merchant_trade_no,
      providerOrderId: input.provider_order_id || '',
      providerTradeNo: input.provider_trade_no || '',
      amount: input.amount,
      currency: input.currency,
      network: input.network || '',
      address: input.address || '',
      memo: input.memo || '',
      payUrl: input.pay_url || '',
      status: input.status,
      providerMessage: input.provider_message || '',
      lastError: input.last_error || '',
      createdAt: input.created_at,
      expiresAt: input.expires_at,
      paidAt: input.paid_at,
      realPayment: true,
      grantsMembership: false,
    };
  }
  function expireIfNeeded(input) {
    if (!input || input.status !== 'awaiting') return input;
    if (Date.parse(input.expires_at) > Date.now()) return input;
    const now = nowIso();
    db.prepare("UPDATE payment_test_orders SET status='expired',updated_at=? WHERE id=? AND status='awaiting'").run(now, input.id);
    return row(input.id);
  }
  function updateOrder(id, fields = {}) {
    const allowed = new Map([
      ['providerOrderId', 'provider_order_id'], ['providerTradeNo', 'provider_trade_no'], ['payUrl', 'pay_url'],
      ['status', 'status'], ['providerMessage', 'provider_message'], ['lastError', 'last_error'], ['paidAt', 'paid_at'],
    ]);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (!entries.length) return row(id);
    const assignments = entries.map(([key]) => `${allowed.get(key)}=?`);
    const values = entries.map(([, value]) => String(value ?? ''));
    assignments.push('updated_at=?');
    values.push(nowIso(), Number(id));
    db.prepare(`UPDATE payment_test_orders SET ${assignments.join(',')} WHERE id=?`).run(...values);
    return row(id);
  }
  function markSettled(input, tradeNo = '', message = '') {
    if (!input) throw Object.assign(new Error('支付测试订单不存在'), { status: 404, code: 'PAYMENT_TEST_NOT_FOUND' });
    if (input.status === 'settled') return input;
    const paidAt = nowIso();
    return updateOrder(input.id, { status: 'settled', providerTradeNo: clean(tradeNo, 300), providerMessage: clean(message, 500), lastError: '', paidAt });
  }

  async function createTestOrder(slug, request = null) {
    const provider = SLUGS.get(String(slug || ''));
    if (!provider || !PROVIDERS.has(provider)) throw Object.assign(new Error('不支持的支付测试渠道'), { status: 404, code: 'PAYMENT_TEST_PROVIDER_NOT_FOUND' });

    let currency = provider === 'okx_usdt' ? 'USDT' : 'CNY';
    let network = '';
    let address = '';
    let memo = '';
    if (provider.startsWith('zpay_')) {
      const config = zpayConfig();
      if (!config.pid || !config.key) throw Object.assign(new Error('ZPAY PID / KEY 尚未配置完整'), { status: 409, code: 'ZPAY_NOT_CONFIGURED' });
    } else if (provider === 'wechat_official') {
      const config = wechatConfig();
      if (!config.appId || !config.mchId || !config.merchantSerialNo || !config.merchantPrivateKeyPem || config.apiV3Key.length !== 32 || !config.platformPublicKeyPem) {
        throw Object.assign(new Error('微信支付官方 API 凭据尚未配置完整'), { status: 409, code: 'WECHAT_OFFICIAL_NOT_CONFIGURED' });
      }
    } else if (provider === 'alipay_official') {
      const config = alipayConfig();
      if (!config.appId || !config.appPrivateKeyPem || !config.alipayPublicKeyPem) throw Object.assign(new Error('支付宝官方 API 凭据尚未配置完整'), { status: 409, code: 'ALIPAY_OFFICIAL_NOT_CONFIGURED' });
    } else if (provider === 'paypal_official') {
      const config = paypalConfig();
      if (!config.clientId || !config.clientSecret) throw Object.assign(new Error('PayPal 官方 API 凭据尚未配置完整'), { status: 409, code: 'PAYPAL_OFFICIAL_NOT_CONFIGURED' });
      currency = config.currency;
    } else if (provider === 'okx_usdt') {
      const config = okxConfig();
      if (!config.apiKey || !config.secretKey || !config.passphrase) throw Object.assign(new Error('OKX 只读 API 凭据尚未配置完整'), { status: 409, code: 'OKX_NOT_CONFIGURED' });
      if (!config.address) throw Object.assign(new Error('USDT 收款地址尚未配置'), { status: 409, code: 'USDT_ADDRESS_NOT_CONFIGURED' });
      network = config.network;
      address = config.address;
      memo = config.memo;
    }

    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + TEST_TTL_MS).toISOString();
    let merchantTradeNo = createNumericTradeNo();
    while (rowByTradeNo(merchantTradeNo)) merchantTradeNo = createNumericTradeNo();
    const info = db.prepare(`INSERT INTO payment_test_orders(provider,merchant_trade_no,amount,currency,network,address,memo,created_at,expires_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(provider, merchantTradeNo, '0.01', currency, network, address, memo, createdAt, expiresAt, createdAt);
    const id = Number(info.lastInsertRowid);

    try {
      let payUrl = `${publicOrigin}/site/api/payment-tests/${id}/checkout`;
      if (provider === 'wechat_official') {
        const created = await createWechatPayClient({ ...wechatConfig(), fetchImpl }).createH5Order({
          description: 'GPTWork 支付链路测试 0.01', outTradeNo: merchantTradeNo,
          notifyUrl: `${publicOrigin}/site/api/payment-tests/wechat/notify`, totalCents: 1,
          clientIp: clean(clientIp(request), 64) || '127.0.0.1',
        });
        const redirectUrl = `${publicOrigin}/admin/settings?paymentTest=${id}#official-payments`;
        const separator = created.payUrl.includes('?') ? '&' : '?';
        payUrl = `${created.payUrl}${separator}redirect_url=${encodeURIComponent(redirectUrl)}`;
      } else if (provider === 'paypal_official') {
        const created = await createPayPalClient({ ...paypalConfig(), fetchImpl }).createOrder({
          referenceId: `payment-test-${id}`, description: 'GPTWork 支付链路测试 0.01', amountCents: 1,
          returnUrl: `${publicOrigin}/site/api/payment-tests/paypal/return/${id}`,
          cancelUrl: `${publicOrigin}/site/api/payment-tests/paypal/cancel/${id}`,
        });
        updateOrder(id, { providerOrderId: created.providerOrderId });
        payUrl = created.payUrl;
      }
      return publicRow(updateOrder(id, { payUrl }));
    } catch (error) {
      updateOrder(id, { status: 'error', lastError: clean(error?.message || error, 500) });
      throw error;
    }
  }

  function zpayCheckout(input) {
    const config = zpayConfig();
    const channel = input.provider === 'zpay_alipay' ? 'alipay' : 'wxpay';
    const params = {
      pid: config.pid,
      type: channel,
      out_trade_no: input.merchant_trade_no,
      notify_url: `${publicOrigin}/site/api/payment-tests/zpay/notify`,
      return_url: `${publicOrigin}/site/api/payment-tests/zpay/return/${input.id}`,
      name: 'GPTWork 支付链路测试 0.01',
      money: input.amount,
      param: `payment-test-${input.id}`,
    };
    const cid = channel === 'alipay' ? config.alipayCid : config.wechatCid;
    if (cid) params.cid = cid;
    params.sign = zpaySign(params, config.key);
    params.sign_type = 'MD5';
    const fields = Object.entries(params).map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`).join('');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZPAY 0.01 支付测试</title></head><body><main><h1>ZPAY 真实支付测试</h1><p>订单 ${htmlEscape(input.merchant_trade_no)}，金额 ¥0.01。此订单仅验证支付链路，不开通会员。</p><form id="pay" method="post" action="${htmlEscape(ZPAY_SUBMIT_URL)}">${fields}<button type="submit">继续支付 ¥0.01</button></form><script>document.getElementById('pay').submit();</script></main></body></html>`;
  }
  function alipayCheckout(input) {
    const form = createAlipayClient(alipayConfig()).createPagePayForm({
      outTradeNo: input.merchant_trade_no,
      subject: 'GPTWork 支付链路测试 0.01',
      totalAmount: 0.01,
      notifyUrl: `${publicOrigin}/site/api/payment-tests/alipay/notify`,
      returnUrl: `${publicOrigin}/site/api/payment-tests/alipay/return/${input.id}`,
    });
    const fields = Object.entries(form.params).map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`).join('');
    return {
      html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>支付宝 0.01 支付测试</title></head><body><main><h1>支付宝真实支付测试</h1><p>订单 ${htmlEscape(input.merchant_trade_no)}，金额 ¥0.01。此订单仅验证支付链路，不开通会员。</p><form id="pay" method="post" action="${htmlEscape(form.gateway)}">${fields}<button type="submit">继续支付 ¥0.01</button></form><script>document.getElementById('pay').submit();</script></main></body></html>`,
      origin: new URL(form.gateway).origin,
    };
  }
  function usdtCheckout(input) {
    const config = okxConfig();
    const link = /^https:\/\//i.test(config.payUrl) ? `<p><a href="${htmlEscape(config.payUrl)}" target="_blank" rel="noopener noreferrer">打开配置的 USDT 转账页面</a></p>` : '';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>USDT 0.01 到账测试</title><style>body{font-family:sans-serif;max-width:760px;margin:40px auto;padding:0 20px}code{word-break:break-all;background:#f4f6f8;padding:3px 6px}li{margin:12px 0}</style></head><body><main><h1>USDT / OKX 真实到账测试</h1><p>请真实转入 <strong>0.01 USDT</strong>。该订单仅验证 OKX 到账识别，不开通会员。</p><ul><li>网络：<code>${htmlEscape(input.network || '请按收款地址对应网络')}</code></li><li>地址：<code>${htmlEscape(input.address)}</code></li>${input.memo ? `<li>Memo / Tag：<code>${htmlEscape(input.memo)}</code></li>` : ''}<li>测试订单：<code>${htmlEscape(input.merchant_trade_no)}</code></li></ul>${link}<p>支付后返回管理后台，系统会自动轮询测试订单状态。</p></main></body></html>`;
  }

  function settleZpay(url) {
    const config = zpayConfig();
    if (!verifyZpaySignature(url.searchParams, config.key)) throw Object.assign(new Error('ZPAY 测试回调签名校验失败'), { status: 400, code: 'ZPAY_TEST_BAD_SIGNATURE' });
    if (url.searchParams.get('pid') !== config.pid) throw Object.assign(new Error('ZPAY 测试回调 PID 不匹配'), { status: 400, code: 'ZPAY_TEST_PID_MISMATCH' });
    if (url.searchParams.get('trade_status') !== 'TRADE_SUCCESS') throw Object.assign(new Error('ZPAY 测试订单尚未支付成功'), { status: 409, code: 'ZPAY_TEST_NOT_PAID' });
    const input = rowByTradeNo(url.searchParams.get('out_trade_no'));
    if (!input || !input.provider.startsWith('zpay_')) throw Object.assign(new Error('ZPAY 测试订单不存在'), { status: 404, code: 'ZPAY_TEST_NOT_FOUND' });
    if (centsFromZpayMoney(url.searchParams.get('money')) !== 1) throw Object.assign(new Error('ZPAY 测试回调金额不是 0.01'), { status: 400, code: 'ZPAY_TEST_AMOUNT_MISMATCH' });
    const expectedType = input.provider === 'zpay_alipay' ? 'alipay' : 'wxpay';
    if (url.searchParams.get('type') !== expectedType) throw Object.assign(new Error('ZPAY 测试回调渠道不匹配'), { status: 400, code: 'ZPAY_TEST_CHANNEL_MISMATCH' });
    return markSettled(input, url.searchParams.get('trade_no'), 'ZPAY 已回调并通过签名、金额、渠道校验');
  }
  async function settleWechat(req) {
    const raw = await readRaw(req);
    const config = wechatConfig();
    const { transaction } = createWechatPayClient({ ...config, fetchImpl }).verifyNotification(req.headers, raw);
    const input = rowByTradeNo(transaction.out_trade_no);
    if (!input || input.provider !== 'wechat_official') throw Object.assign(new Error('微信支付测试订单不存在'), { status: 404, code: 'WECHAT_TEST_NOT_FOUND' });
    if (transaction.trade_state !== 'SUCCESS') throw Object.assign(new Error('微信支付测试订单尚未成功'), { status: 409, code: 'WECHAT_TEST_NOT_PAID' });
    if (String(transaction.mchid || '') !== config.mchId || String(transaction.appid || '') !== config.appId) throw Object.assign(new Error('微信支付测试商户身份不匹配'), { status: 400, code: 'WECHAT_TEST_MERCHANT_MISMATCH' });
    if (Number(transaction.amount?.total) !== 1 || String(transaction.amount?.currency || 'CNY') !== 'CNY') throw Object.assign(new Error('微信支付测试金额或币种不匹配'), { status: 400, code: 'WECHAT_TEST_AMOUNT_MISMATCH' });
    return markSettled(input, transaction.transaction_id, '微信支付通知验签、解密、商户和金额校验全部通过');
  }
  async function settleAlipay(req) {
    const raw = await readRaw(req);
    const params = createAlipayClient(alipayConfig()).verifyNotification(new URLSearchParams(raw));
    const input = rowByTradeNo(params.out_trade_no);
    if (!input || input.provider !== 'alipay_official') throw Object.assign(new Error('支付宝测试订单不存在'), { status: 404, code: 'ALIPAY_TEST_NOT_FOUND' });
    const config = alipayConfig();
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(String(params.trade_status))) throw Object.assign(new Error('支付宝测试订单尚未成功'), { status: 409, code: 'ALIPAY_TEST_NOT_PAID' });
    if (String(params.app_id || '') !== config.appId) throw Object.assign(new Error('支付宝测试 AppID 不匹配'), { status: 400, code: 'ALIPAY_TEST_APPID_MISMATCH' });
    if (decimalToCents(params.total_amount) !== 1) throw Object.assign(new Error('支付宝测试金额不是 0.01'), { status: 400, code: 'ALIPAY_TEST_AMOUNT_MISMATCH' });
    return markSettled(input, params.trade_no, '支付宝通知 RSA2 验签、AppID 和金额校验全部通过');
  }
  async function settlePaypal(id, url) {
    const input = row(id);
    if (!input || input.provider !== 'paypal_official') throw Object.assign(new Error('PayPal 测试订单不存在'), { status: 404, code: 'PAYPAL_TEST_NOT_FOUND' });
    if (input.status === 'settled') return input;
    const token = clean(url.searchParams.get('token'), 256);
    if (!token || token !== input.provider_order_id) throw Object.assign(new Error('PayPal 测试返回订单号不匹配'), { status: 400, code: 'PAYPAL_TEST_ORDER_MISMATCH' });
    const config = paypalConfig();
    const result = await createPayPalClient({ ...config, fetchImpl }).captureOrder(input.provider_order_id);
    if (result.status !== 'COMPLETED') throw Object.assign(new Error('PayPal 测试订单尚未完成'), { status: 409, code: 'PAYPAL_TEST_NOT_COMPLETED' });
    const unit = (result.purchase_units || []).find((item) => item.reference_id === `payment-test-${input.id}`) || result.purchase_units?.[0];
    const capture = unit?.payments?.captures?.find((item) => item.status === 'COMPLETED') || unit?.payments?.captures?.[0];
    if (!unit || unit.reference_id !== `payment-test-${input.id}` || !capture || capture.status !== 'COMPLETED') throw Object.assign(new Error('PayPal 测试 Capture 不完整'), { status: 502, code: 'PAYPAL_TEST_CAPTURE_MISSING' });
    if (String(capture.amount?.currency_code || '') !== input.currency || decimalToCents(capture.amount?.value) !== 1) throw Object.assign(new Error('PayPal 测试金额或币种不匹配'), { status: 400, code: 'PAYPAL_TEST_AMOUNT_MISMATCH' });
    return markSettled(input, capture.id, 'PayPal Capture 完成，reference_id、币种和金额校验全部通过');
  }

  async function checkOkx(input) {
    input = expireIfNeeded(input);
    if (!input || input.provider !== 'okx_usdt' || input.status !== 'awaiting') return input;
    const config = okxConfig();
    const client = createOkxClient({
      apiKey: config.apiKey, secretKey: config.secretKey, passphrase: config.passphrase,
      baseUrl: env.GPTLOCK_OKX_API_BASE || OKX_DEFAULT_BASE_URL, fetchImpl,
    });
    const deposits = await client.getDepositHistory({ ccy: 'USDT', limit: 100 });
    const createdMs = Date.parse(input.created_at);
    const expiresMs = Date.parse(input.expires_at);
    const matches = deposits.filter((deposit) => {
      if (decimalToMicros(deposit?.amt) !== 10_000) return false;
      if (String(deposit?.ccy || '').toUpperCase() !== 'USDT') return false;
      const ts = Number(deposit?.ts || 0);
      if (!Number.isFinite(ts) || ts < createdMs - OKX_CLOCK_SKEW_MS || ts > expiresMs + OKX_GRACE_MS) return false;
      const chain = clean(deposit?.chain, 80);
      const to = clean(deposit?.to, 256);
      const internal = String(deposit?.type || '') === '3' || (!chain && !to);
      if (input.network && chain && !sameText(input.network, chain)) return false;
      if (input.address && to && !sameText(input.address, to)) return false;
      if ((input.network || input.address) && internal && !config.allowInternalTransfers) return false;
      if (input.address && !to && !internal) return false;
      return true;
    });
    if (!matches.length) return input;
    if (matches.length > 1) return updateOrder(input.id, { providerMessage: `发现 ${matches.length} 笔 0.01 USDT 候选充值，无法唯一确认，请人工核对。` });
    const deposit = matches[0];
    if (String(deposit.state || '') !== '2') return updateOrder(input.id, { providerMessage: '已发现 0.01 USDT 充值，等待 OKX 最终到账状态。' });
    return markSettled(input, clean(deposit.txId || deposit.depId, 300), 'OKX 已确认 0.01 USDT 到账，金额、时间、网络/地址校验通过');
  }

  async function getTestOrder(id, { refresh = false } = {}) {
    let input = expireIfNeeded(row(id));
    if (refresh && input?.provider === 'okx_usdt' && input.status === 'awaiting') {
      try { input = await checkOkx(input); }
      catch (error) { input = updateOrder(input.id, { lastError: clean(error?.message || error, 500) }); }
    }
    return publicRow(input);
  }

  async function handleAdmin(req, res, url) {
    if (!url.pathname.startsWith('/admin/api/payment-tests')) return false;
    try {
      if (url.pathname === '/admin/api/payment-tests' && req.method === 'GET') {
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 10) || 10));
        const rows = db.prepare('SELECT * FROM payment_test_orders ORDER BY id DESC LIMIT ?').all(limit).map((item) => publicRow(expireIfNeeded(item)));
        writeJson(res, 200, { ok: true, testOrders: rows });
        return true;
      }
      const createMatch = url.pathname.match(/^\/admin\/api\/payment-tests\/(zpay-wechat|zpay-alipay|wechat|alipay|paypal|usdt)$/);
      if (createMatch && req.method === 'POST') {
        const testOrder = await createTestOrder(createMatch[1], req);
        writeJson(res, 201, { ok: true, testOrder, warning: '这是 0.01 的真实支付/到账测试订单，不会开通会员。' });
        return true;
      }
      const statusMatch = url.pathname.match(/^\/admin\/api\/payment-tests\/(\d+)$/);
      if (statusMatch && req.method === 'GET') {
        const testOrder = await getTestOrder(Number(statusMatch[1]), { refresh: url.searchParams.get('refresh') === '1' });
        if (!testOrder) throw Object.assign(new Error('支付测试订单不存在'), { status: 404, code: 'PAYMENT_TEST_NOT_FOUND' });
        writeJson(res, 200, { ok: true, testOrder });
        return true;
      }
      writeJson(res, 404, { ok: false, error: { code: 'PAYMENT_TEST_ROUTE_NOT_FOUND', message: '支付测试接口不存在' } });
      return true;
    } catch (error) {
      writeJson(res, error.status || 500, { ok: false, error: { code: error.code || 'PAYMENT_TEST_ERROR', message: error.status ? error.message : '支付测试处理失败' } });
      return true;
    }
  }

  async function handleSite(req, res, url) {
    if (!url.pathname.startsWith('/site/api/payment-tests/')) return false;
    try {
      const checkout = url.pathname.match(/^\/site\/api\/payment-tests\/(\d+)\/checkout$/);
      if (checkout && req.method === 'GET') {
        const input = expireIfNeeded(row(Number(checkout[1])));
        if (!input || input.status !== 'awaiting') throw Object.assign(new Error('支付测试订单已失效或不存在'), { status: 404, code: 'PAYMENT_TEST_NOT_PAYABLE' });
        if (input.provider.startsWith('zpay_')) {
          const html = zpayCheckout(input);
          writeHtml(res, 200, html, `default-src 'none'; script-src 'unsafe-inline'; form-action https:; base-uri 'none'; frame-ancestors 'none'`);
          return true;
        }
        if (input.provider === 'alipay_official') {
          const page = alipayCheckout(input);
          writeHtml(res, 200, page.html, `default-src 'none'; script-src 'unsafe-inline'; form-action https:; base-uri 'none'; frame-ancestors 'none'`);
          return true;
        }
        if (input.provider === 'okx_usdt') {
          writeHtml(res, 200, usdtCheckout(input), "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; navigate-to https:");
          return true;
        }
        throw Object.assign(new Error('该支付测试订单不使用站内收银台'), { status: 409, code: 'PAYMENT_TEST_DIRECT_URL' });
      }
      if (url.pathname === '/site/api/payment-tests/zpay/notify' && req.method === 'GET') {
        settleZpay(url);
        writeText(res, 200, 'success');
        return true;
      }
      const zpayReturn = url.pathname.match(/^\/site\/api\/payment-tests\/zpay\/return\/(\d+)$/);
      if (zpayReturn && req.method === 'GET') {
        try { settleZpay(url); } catch (error) { logger.warn?.('GPTWork ZPAY payment test return not settled:', error.code || '', error.message); }
        redirect(res, `${publicOrigin}/admin/settings?paymentTest=${Number(zpayReturn[1])}#other-payments`);
        return true;
      }
      if (url.pathname === '/site/api/payment-tests/wechat/notify' && req.method === 'POST') {
        await settleWechat(req);
        writeJson(res, 200, { code: 'SUCCESS', message: '成功' });
        return true;
      }
      if (url.pathname === '/site/api/payment-tests/alipay/notify' && req.method === 'POST') {
        await settleAlipay(req);
        writeText(res, 200, 'success');
        return true;
      }
      const alipayReturn = url.pathname.match(/^\/site\/api\/payment-tests\/alipay\/return\/(\d+)$/);
      if (alipayReturn && req.method === 'GET') {
        redirect(res, `${publicOrigin}/admin/settings?paymentTest=${Number(alipayReturn[1])}#official-payments`);
        return true;
      }
      const paypalReturn = url.pathname.match(/^\/site\/api\/payment-tests\/paypal\/return\/(\d+)$/);
      if (paypalReturn && req.method === 'GET') {
        await settlePaypal(Number(paypalReturn[1]), url);
        redirect(res, `${publicOrigin}/admin/settings?paymentTest=${Number(paypalReturn[1])}#official-payments`);
        return true;
      }
      const paypalCancel = url.pathname.match(/^\/site\/api\/payment-tests\/paypal\/cancel\/(\d+)$/);
      if (paypalCancel && req.method === 'GET') {
        const input = row(Number(paypalCancel[1]));
        if (input?.status === 'awaiting') updateOrder(input.id, { status: 'cancelled', providerMessage: '用户取消 PayPal 测试支付' });
        redirect(res, `${publicOrigin}/admin/settings?paymentTest=${Number(paypalCancel[1])}#official-payments`);
        return true;
      }
      return false;
    } catch (error) {
      logger.warn?.('GPTWork payment test callback rejected:', error.code || '', error.message);
      if (url.pathname.includes('/wechat/notify')) writeJson(res, error.status || 500, { code: 'FAIL', message: error.status ? error.message : '处理失败' });
      else if (url.pathname.includes('/zpay/notify') || url.pathname.includes('/alipay/notify')) writeText(res, error.status || 500, 'fail');
      else writeText(res, error.status || 500, error.status ? error.message : 'Payment test failed');
      return true;
    }
  }

  return { handleAdmin, handleSite, createTestOrder, getTestOrder, publicRow };
}

export const paymentTestInternals = { decimalToCents, decimalToMicros, sameText, SLUGS };
