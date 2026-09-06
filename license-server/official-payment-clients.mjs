import {
  createDecipheriv,
  createSign,
  createVerify,
  randomBytes,
} from 'node:crypto';

function clean(value, max = 2048) { return String(value ?? '').trim().slice(0, max); }
function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is unavailable');
}
async function responseJson(response, provider) {
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    const detail = body?.message || body?.error_description || body?.error || body?.sub_msg || body?.msg || `HTTP ${response.status}`;
    throw Object.assign(new Error(`${provider} API 请求失败：${detail}`), { status: 502, code: `${provider.toUpperCase()}_API_ERROR`, providerStatus: response.status, providerBody: body });
  }
  return body;
}

function rsaSignBase64(payload, privateKeyPem) {
  const signer = createSign('RSA-SHA256');
  signer.update(payload, 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}
function rsaVerifyBase64(payload, signature, publicKeyPem) {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(payload, 'utf8');
  verifier.end();
  return verifier.verify(publicKeyPem, signature, 'base64');
}

export function createWechatPayClient({
  appId,
  mchId,
  merchantSerialNo,
  merchantPrivateKeyPem,
  apiV3Key,
  platformSerialNo,
  platformPublicKeyPem,
  fetchImpl = globalThis.fetch,
}) {
  assertFetch(fetchImpl);
  const config = {
    appId: clean(appId, 128),
    mchId: clean(mchId, 64),
    merchantSerialNo: clean(merchantSerialNo, 128),
    merchantPrivateKeyPem: String(merchantPrivateKeyPem || ''),
    apiV3Key: String(apiV3Key || ''),
    platformSerialNo: clean(platformSerialNo, 128),
    platformPublicKeyPem: String(platformPublicKeyPem || ''),
  };
  function configured() {
    return Boolean(config.appId && config.mchId && config.merchantSerialNo && config.merchantPrivateKeyPem && config.apiV3Key.length === 32);
  }
  function authorization(method, url, body = '') {
    if (!configured()) throw Object.assign(new Error('微信支付官方 API 凭据未配置完整'), { status: 409, code: 'WECHAT_OFFICIAL_NOT_CONFIGURED' });
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const message = `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = rsaSignBase64(message, config.merchantPrivateKeyPem);
    return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.merchantSerialNo}",signature="${signature}"`;
  }
  async function request(method, path, payload = null) {
    const url = `https://api.mch.weixin.qq.com${path}`;
    const body = payload === null ? '' : JSON.stringify(payload);
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(payload === null ? {} : { 'content-type': 'application/json' }),
        authorization: authorization(method, url, body),
      },
      ...(payload === null ? {} : { body }),
    });
    return responseJson(response, 'wechat');
  }
  async function createH5Order({ description, outTradeNo, notifyUrl, totalCents, clientIp }) {
    const total = Number(totalCents);
    if (!Number.isInteger(total) || total < 1) throw new Error('微信支付金额必须是正整数分');
    const result = await request('POST', '/v3/pay/transactions/h5', {
      appid: config.appId,
      mchid: config.mchId,
      description: clean(description, 127),
      out_trade_no: clean(outTradeNo, 32),
      notify_url: clean(notifyUrl, 256),
      amount: { total, currency: 'CNY' },
      scene_info: {
        payer_client_ip: clean(clientIp, 64) || '127.0.0.1',
        h5_info: { type: 'Wap' },
      },
    });
    if (!result.h5_url) throw Object.assign(new Error('微信支付未返回 H5 支付地址'), { status: 502, code: 'WECHAT_H5_URL_MISSING' });
    return { payUrl: String(result.h5_url), raw: result };
  }
  async function testConnection() {
    const result = await request('GET', '/v3/certificates');
    return { connected: true, certificateCount: Array.isArray(result.data) ? result.data.length : 0 };
  }
  function verifyNotification(headers, rawBody) {
    if (!config.platformPublicKeyPem) throw Object.assign(new Error('尚未配置微信支付平台公钥，无法验证支付通知'), { status: 409, code: 'WECHAT_PLATFORM_KEY_MISSING' });
    const timestamp = clean(headers['wechatpay-timestamp'], 32);
    const nonce = clean(headers['wechatpay-nonce'], 128);
    const signature = clean(headers['wechatpay-signature'], 2048);
    const serial = clean(headers['wechatpay-serial'], 128);
    if (!timestamp || !nonce || !signature) throw Object.assign(new Error('微信支付通知签名头缺失'), { status: 400, code: 'WECHAT_NOTIFY_HEADERS_MISSING' });
    if (config.platformSerialNo && serial && serial !== config.platformSerialNo) throw Object.assign(new Error('微信支付平台公钥序列号不匹配'), { status: 400, code: 'WECHAT_PLATFORM_SERIAL_MISMATCH' });
    const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
    if (!rsaVerifyBase64(message, signature, config.platformPublicKeyPem)) throw Object.assign(new Error('微信支付通知签名验证失败'), { status: 400, code: 'WECHAT_BAD_SIGNATURE' });
    let envelope;
    try { envelope = JSON.parse(rawBody); } catch { throw Object.assign(new Error('微信支付通知 JSON 无效'), { status: 400, code: 'WECHAT_NOTIFY_JSON_INVALID' }); }
    const resource = envelope?.resource || {};
    const ciphertext = Buffer.from(String(resource.ciphertext || ''), 'base64');
    if (config.apiV3Key.length !== 32 || ciphertext.length <= 16 || !resource.nonce) throw Object.assign(new Error('微信支付通知资源无法解密'), { status: 400, code: 'WECHAT_NOTIFY_RESOURCE_INVALID' });
    const data = ciphertext.subarray(0, ciphertext.length - 16);
    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(config.apiV3Key, 'utf8'), Buffer.from(String(resource.nonce), 'utf8'));
    decipher.setAuthTag(authTag);
    if (resource.associated_data) decipher.setAAD(Buffer.from(String(resource.associated_data), 'utf8'));
    let plaintext;
    try { plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'); }
    catch { throw Object.assign(new Error('微信支付通知资源解密失败'), { status: 400, code: 'WECHAT_NOTIFY_DECRYPT_FAILED' }); }
    let transaction;
    try { transaction = JSON.parse(plaintext); } catch { throw Object.assign(new Error('微信支付通知交易数据无效'), { status: 400, code: 'WECHAT_NOTIFY_TRANSACTION_INVALID' }); }
    return { envelope, transaction };
  }
  return { configured, createH5Order, testConnection, verifyNotification };
}

function alipayEncode(value) { return encodeURIComponent(String(value)).replace(/%20/g, '+'); }
function alipayCanonical(params, { omit = new Set(['sign', 'sign_type']) } = {}) {
  return Object.entries(params)
    .filter(([key, value]) => !omit.has(key) && value !== undefined && value !== null && String(value) !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');
}
export function createAlipayClient({
  appId,
  appPrivateKeyPem,
  alipayPublicKeyPem,
  sandbox = false,
}) {
  const config = {
    appId: clean(appId, 128),
    appPrivateKeyPem: String(appPrivateKeyPem || ''),
    alipayPublicKeyPem: String(alipayPublicKeyPem || ''),
    sandbox: Boolean(sandbox),
  };
  const gateway = config.sandbox ? 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' : 'https://openapi.alipay.com/gateway.do';
  function configured() { return Boolean(config.appId && config.appPrivateKeyPem && config.alipayPublicKeyPem); }
  function signedParameters({ method, bizContent, notifyUrl = '', returnUrl = '', timestamp = new Date() }) {
    if (!configured()) throw Object.assign(new Error('支付宝官方 API 凭据未配置完整'), { status: 409, code: 'ALIPAY_OFFICIAL_NOT_CONFIGURED' });
    const pad = (value) => String(value).padStart(2, '0');
    const dateText = `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())} ${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}:${pad(timestamp.getSeconds())}`;
    const params = {
      app_id: config.appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: dateText,
      version: '1.0',
      ...(notifyUrl ? { notify_url: notifyUrl } : {}),
      ...(returnUrl ? { return_url: returnUrl } : {}),
      biz_content: JSON.stringify(bizContent),
    };
    params.sign = rsaSignBase64(alipayCanonical(params), config.appPrivateKeyPem);
    return params;
  }
  function createPagePayForm({ outTradeNo, subject, totalAmount, notifyUrl, returnUrl }) {
    const params = signedParameters({
      method: 'alipay.trade.page.pay',
      notifyUrl,
      returnUrl,
      bizContent: {
        out_trade_no: clean(outTradeNo, 64),
        product_code: 'FAST_INSTANT_TRADE_PAY',
        total_amount: Number(totalAmount).toFixed(2),
        subject: clean(subject, 128),
      },
    });
    return { gateway, params };
  }
  function verifyNotification(input) {
    if (!configured()) throw Object.assign(new Error('支付宝官方 API 凭据未配置完整'), { status: 409, code: 'ALIPAY_OFFICIAL_NOT_CONFIGURED' });
    const params = input instanceof URLSearchParams ? Object.fromEntries(input.entries()) : { ...(input || {}) };
    const signature = String(params.sign || '');
    if (!signature || !rsaVerifyBase64(alipayCanonical(params), signature, config.alipayPublicKeyPem)) {
      throw Object.assign(new Error('支付宝通知签名验证失败'), { status: 400, code: 'ALIPAY_BAD_SIGNATURE' });
    }
    return params;
  }
  function selfTest() {
    const probe = signedParameters({ method: 'alipay.trade.query', bizContent: { out_trade_no: `GPTWORK_TEST_${Date.now()}` } });
    return { configured: true, gateway, signatureLength: String(probe.sign || '').length };
  }
  return { configured, gateway, createPagePayForm, verifyNotification, selfTest };
}

export function createPayPalClient({
  clientId,
  clientSecret,
  sandbox = false,
  currency = 'CNY',
  fetchImpl = globalThis.fetch,
}) {
  assertFetch(fetchImpl);
  const config = {
    clientId: clean(clientId, 256),
    clientSecret: String(clientSecret || ''),
    sandbox: Boolean(sandbox),
    currency: clean(currency, 3).toUpperCase() || 'CNY',
  };
  const baseUrl = config.sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  function configured() { return Boolean(config.clientId && config.clientSecret); }
  async function accessToken() {
    if (!configured()) throw Object.assign(new Error('PayPal 官方 API 凭据未配置完整'), { status: 409, code: 'PAYPAL_OFFICIAL_NOT_CONFIGURED' });
    const response = await fetchImpl(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await responseJson(response, 'paypal');
    if (!body.access_token) throw Object.assign(new Error('PayPal OAuth 未返回 access_token'), { status: 502, code: 'PAYPAL_ACCESS_TOKEN_MISSING' });
    return String(body.access_token);
  }
  async function api(method, path, payload = null, requestId = '') {
    const token = await accessToken();
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(payload === null ? {} : { 'content-type': 'application/json' }),
        ...(requestId ? { 'paypal-request-id': requestId } : {}),
        prefer: 'return=representation',
      },
      ...(payload === null ? {} : { body: JSON.stringify(payload) }),
    });
    return responseJson(response, 'paypal');
  }
  async function createOrder({ referenceId, description, amountCents, returnUrl, cancelUrl }) {
    const cents = Number(amountCents);
    if (!Number.isInteger(cents) || cents < 1) throw new Error('PayPal 金额必须是正整数最小货币单位');
    const result = await api('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: clean(referenceId, 256),
        description: clean(description, 127),
        amount: { currency_code: config.currency, value: (cents / 100).toFixed(2) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            user_action: 'PAY_NOW',
            return_url: clean(returnUrl, 2048),
            cancel_url: clean(cancelUrl, 2048),
          },
        },
      },
    }, `gptwork-${clean(referenceId, 64)}`);
    const approve = (result.links || []).find((item) => item.rel === 'payer-action' || item.rel === 'approve');
    if (!result.id || !approve?.href) throw Object.assign(new Error('PayPal 创建订单后未返回付款跳转地址'), { status: 502, code: 'PAYPAL_APPROVAL_URL_MISSING' });
    return { providerOrderId: String(result.id), payUrl: String(approve.href), raw: result };
  }
  async function captureOrder(providerOrderId) {
    return api('POST', `/v2/checkout/orders/${encodeURIComponent(providerOrderId)}/capture`, {});
  }
  async function getOrder(providerOrderId) {
    return api('GET', `/v2/checkout/orders/${encodeURIComponent(providerOrderId)}`);
  }
  async function testConnection() {
    await accessToken();
    return { connected: true, baseUrl, currency: config.currency };
  }
  return { configured, baseUrl, currency: config.currency, createOrder, captureOrder, getOrder, testConnection };
}

export const officialPaymentInternals = {
  alipayCanonical,
  rsaSignBase64,
  rsaVerifyBase64,
};
