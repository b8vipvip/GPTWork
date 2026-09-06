import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { createAlipayClient, createPayPalClient, createWechatPayClient } from './official-payment-clients.mjs';

const OFFICIAL_PROVIDERS = new Set(['wechat_official', 'alipay_official', 'paypal_official']);
const PAYMENT_CODES = new Set(['wechat', 'alipay', 'paypal']);
const MAX_BODY = 2 * 1024 * 1024;

function nowIso() { return new Date().toISOString(); }
function clean(value, max = 2048) { return String(value ?? '').trim().slice(0, max); }
function centsFromDecimal(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}
function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
async function readRaw(req, max = MAX_BODY) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('支付回调内容过大'), { status: 413, code: 'OFFICIAL_PAYMENT_BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function readJson(req) {
  const raw = await readRaw(req, 256 * 1024);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error('请求 JSON 无效'), { status: 400, code: 'INVALID_JSON' }); }
}
function writeText(res, status, text) {
  const payload = Buffer.from(String(text), 'utf8');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}
function writeJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}

function ensurePaypalPaymentMethod(db) {
  const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='payment_methods'").get();
  if (!schema) throw new Error('payment_methods table must be initialized before official payments');
  const sql = String(schema.sql || '');
  if (!/CHECK\s*\(\s*code\s+IN\s*\([^)]*'paypal'/i.test(sql)) {
    const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys || 0);
    if (foreignKeys) db.exec('PRAGMA foreign_keys=OFF;');
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE payment_methods_official (
          code TEXT PRIMARY KEY CHECK(code IN ('wechat','alipay','usdt','paypal')),
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
          pay_url TEXT NOT NULL DEFAULT '',
          instructions TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO payment_methods_official(code,name,enabled,pay_url,instructions,updated_at)
          SELECT code,name,enabled,pay_url,instructions,updated_at FROM payment_methods;
        DROP TABLE payment_methods;
        ALTER TABLE payment_methods_official RENAME TO payment_methods;
        COMMIT;
      `);
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    } finally {
      if (foreignKeys) db.exec('PRAGMA foreign_keys=ON;');
    }
  }
  db.prepare('INSERT OR IGNORE INTO payment_methods(code,name,enabled,pay_url,instructions,updated_at) VALUES(?,?,?,?,?,?)')
    .run('paypal', 'PayPal', 0, '', '通过 PayPal 官方 Checkout 完成付款，支付成功后系统自动确认并开通会员。', nowIso());
  const detailsExists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='payment_method_details'").get();
  if (detailsExists) {
    db.prepare('INSERT OR IGNORE INTO payment_method_details(code,crypto_asset,updated_at) VALUES(?,?,?)').run('paypal', '', nowIso());
  }
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) throw new Error(`official payment migration created ${violations.length} foreign key violation(s)`);
}

export function createOfficialPaymentSystem({ db, publicOrigin, secret = '', fetchImpl = globalThis.fetch, logger = console }) {
  ensurePaypalPaymentMethod(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS official_payment_orders (
      order_id INTEGER PRIMARY KEY REFERENCES membership_orders(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('wechat_official','alipay_official','paypal_official')),
      merchant_trade_no TEXT NOT NULL UNIQUE,
      provider_order_id TEXT NOT NULL DEFAULT '',
      provider_trade_no TEXT NOT NULL DEFAULT '',
      amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'CNY',
      client_ip TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'awaiting' CHECK(status IN ('awaiting','settled','error')),
      paid_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_official_provider_order ON official_payment_orders(provider,provider_order_id) WHERE provider_order_id<>'';
  `);

  let settleOrderById = null;
  const providerStatus = {
    wechat: { lastTestAt: null, lastError: '' },
    alipay: { lastTestAt: null, lastError: '' },
    paypal: { lastTestAt: null, lastError: '' },
  };
  const CONFIG_KEY = secret ? createHmac('sha256', secret).update('gptwork-official-payments:v1').digest() : null;

  function getSetting(key, fallback = '') {
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    return row ? row.value : fallback;
  }
  function setSetting(key, value) {
    db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(value), nowIso());
  }
  function encrypt(value, keyName) {
    if (!CONFIG_KEY) throw Object.assign(new Error('服务端主密钥不可用，无法保存官方支付密钥'), { status: 500, code: 'PAYMENT_SECRET_UNAVAILABLE' });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', CONFIG_KEY, iv);
    cipher.setAAD(Buffer.from(`gptwork-official-payment:v1:${keyName}`));
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
  }
  function decrypt(value, keyName) {
    if (!value || !CONFIG_KEY) return '';
    try {
      const [version, ivText, tagText, dataText] = String(value).split('.');
      if (version !== 'v1') return '';
      const decipher = createDecipheriv('aes-256-gcm', CONFIG_KEY, Buffer.from(ivText, 'base64url'));
      decipher.setAAD(Buffer.from(`gptwork-official-payment:v1:${keyName}`));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
    } catch { return ''; }
  }
  function getSecure(key) {
    const row = db.prepare('SELECT ciphertext FROM secure_settings WHERE key=?').get(key);
    return row ? decrypt(row.ciphertext, key) : '';
  }
  function setSecure(key, value) {
    if (!value) return db.prepare('DELETE FROM secure_settings WHERE key=?').run(key);
    db.prepare(`INSERT INTO secure_settings(key,ciphertext,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`).run(key, encrypt(value, key), nowIso());
  }
  function hint(value) {
    const raw = String(value || '');
    if (!raw) return '';
    return raw.length <= 10 ? `${raw.slice(0, 2)}…` : `${raw.slice(0, 4)}…${raw.slice(-4)}`;
  }
  function providerFor(code) {
    if (code === 'paypal') return 'paypal_official';
    if (code === 'wechat' || code === 'alipay') {
      const value = getSetting(`payment_provider_${code}`, 'manual');
      return OFFICIAL_PROVIDERS.has(value) ? value : value === 'zpay' ? 'zpay' : 'manual';
    }
    return '';
  }
  function wechatConfig() {
    const config = {
      appId: getSetting('wechat_official_app_id', ''),
      mchId: getSetting('wechat_official_mch_id', ''),
      merchantSerialNo: getSetting('wechat_official_merchant_serial', ''),
      merchantPrivateKeyPem: getSecure('wechat_official_merchant_private_key'),
      apiV3Key: getSecure('wechat_official_api_v3_key'),
      platformSerialNo: getSetting('wechat_official_platform_serial', ''),
      platformPublicKeyPem: getSecure('wechat_official_platform_public_key'),
    };
    return { ...config, configured: Boolean(config.appId && config.mchId && config.merchantSerialNo && config.merchantPrivateKeyPem && config.apiV3Key.length === 32 && config.platformPublicKeyPem) };
  }
  function alipayConfig() {
    const config = {
      appId: getSetting('alipay_official_app_id', ''),
      appPrivateKeyPem: getSecure('alipay_official_app_private_key'),
      alipayPublicKeyPem: getSecure('alipay_official_public_key'),
      sandbox: getSetting('alipay_official_sandbox', '0') === '1',
    };
    return { ...config, configured: Boolean(config.appId && config.appPrivateKeyPem && config.alipayPublicKeyPem) };
  }
  function paypalConfig() {
    const config = {
      clientId: getSetting('paypal_official_client_id', ''),
      clientSecret: getSecure('paypal_official_client_secret'),
      sandbox: getSetting('paypal_official_sandbox', '1') === '1',
      currency: clean(getSetting('paypal_official_currency', 'CNY'), 3).toUpperCase() || 'CNY',
    };
    return { ...config, configured: Boolean(config.clientId && config.clientSecret) };
  }
  function wechatClient() { return createWechatPayClient({ ...wechatConfig(), fetchImpl }); }
  function alipayClient() { return createAlipayClient(alipayConfig()); }
  function paypalClient() { return createPayPalClient({ ...paypalConfig(), fetchImpl }); }

  function publicConfig(code) {
    const status = providerStatus[code] || { lastTestAt: null, lastError: '' };
    if (code === 'wechat') {
      const config = wechatConfig();
      return {
        provider: providerFor(code), configured: config.configured,
        appId: config.appId, mchIdHint: hint(config.mchId), merchantSerialNo: config.merchantSerialNo,
        privateKeyConfigured: Boolean(config.merchantPrivateKeyPem), apiV3KeyConfigured: Boolean(config.apiV3Key),
        platformSerialNo: config.platformSerialNo, platformPublicKeyConfigured: Boolean(config.platformPublicKeyPem), ...status,
      };
    }
    if (code === 'alipay') {
      const config = alipayConfig();
      return {
        provider: providerFor(code), configured: config.configured, appId: config.appId, sandbox: config.sandbox,
        privateKeyConfigured: Boolean(config.appPrivateKeyPem), publicKeyConfigured: Boolean(config.alipayPublicKeyPem), ...status,
      };
    }
    const config = paypalConfig();
    return {
      provider: 'paypal_official', configured: config.configured, clientIdHint: hint(config.clientId), sandbox: config.sandbox,
      currency: config.currency, clientSecretConfigured: Boolean(config.clientSecret), ...status,
    };
  }

  function enrichList(rows, enabledOnly = false) {
    const mapped = (rows || []).map((item) => {
      const code = item.code;
      if (!PAYMENT_CODES.has(code)) return item;
      const provider = providerFor(code);
      const official = provider === `${code}_official` || (code === 'paypal' && provider === 'paypal_official');
      if (!official) return item;
      const config = code === 'wechat' ? wechatConfig() : code === 'alipay' ? alipayConfig() : paypalConfig();
      return {
        ...item,
        provider,
        payUrl: '',
        qrConfigured: false,
        qrUrl: '',
        autoConfirm: Boolean(config.configured),
      };
    });
    return enabledOnly ? mapped.filter((item) => {
      const provider = providerFor(item.code);
      const official = provider === `${item.code}_official` || (item.code === 'paypal' && provider === 'paypal_official');
      if (!official) return true;
      const config = item.code === 'wechat' ? wechatConfig() : item.code === 'alipay' ? alipayConfig() : paypalConfig();
      return config.configured;
    }) : mapped;
  }

  function ensureOfficialOrder(order, provider, clientIp = '') {
    const existing = db.prepare('SELECT * FROM official_payment_orders WHERE order_id=?').get(Number(order.id));
    if (existing) {
      if (existing.provider !== provider || Number(existing.amount_cents) !== Number(order.amount_cents)) {
        throw Object.assign(new Error('官方支付订单快照与当前订单不一致'), { status: 409, code: 'OFFICIAL_ORDER_MISMATCH' });
      }
      return existing;
    }
    const merchantTradeNo = `GW${Date.now()}${String(order.id).padStart(8, '0')}`.slice(0, 32);
    db.prepare(`INSERT INTO official_payment_orders(order_id,provider,merchant_trade_no,amount_cents,currency,client_ip,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(order.id, provider, merchantTradeNo, Number(order.amount_cents), provider === 'paypal_official' ? paypalConfig().currency : 'CNY', clean(clientIp, 64), nowIso());
    return db.prepare('SELECT * FROM official_payment_orders WHERE order_id=?').get(Number(order.id));
  }
  function officialOrder(orderId) { return db.prepare('SELECT * FROM official_payment_orders WHERE order_id=?').get(Number(orderId)); }
  function orderRow(orderId) { return db.prepare('SELECT * FROM membership_orders WHERE id=?').get(Number(orderId)); }
  function orderSubject(order) {
    let snapshot = {};
    try { snapshot = JSON.parse(order.plan_snapshot_json || '{}'); } catch {}
    return `GPTWork ${clean(snapshot.name || snapshot.code || order.plan_code || '会员', 80)}`;
  }
  function requireSettlement() {
    if (!settleOrderById) throw Object.assign(new Error('会员自动开通回调尚未就绪'), { status: 503, code: 'SETTLEMENT_NOT_READY' });
  }
  async function settleOfficial(detail, context) {
    const order = orderRow(detail.order_id);
    if (!order) throw Object.assign(new Error('会员订单不存在'), { status: 404, code: 'ORDER_NOT_FOUND' });
    if (detail.status === 'settled' || order.status === 'paid') return order.id;
    requireSettlement();
    await Promise.resolve(settleOrderById(order.id, context));
    const paidAt = nowIso();
    db.prepare(`UPDATE official_payment_orders SET status='settled',provider_trade_no=?,paid_at=?,last_error='',updated_at=? WHERE order_id=?`)
      .run(clean(context.tradeNo || '', 240), paidAt, paidAt, order.id);
    return order.id;
  }

  async function prepareOrder(order, context = {}) {
    if (!order || !PAYMENT_CODES.has(order.payment_method)) return order;
    const provider = providerFor(order.payment_method);
    if (!OFFICIAL_PROVIDERS.has(provider)) return order;
    const config = provider === 'wechat_official' ? wechatConfig() : provider === 'alipay_official' ? alipayConfig() : paypalConfig();
    if (!config.configured) throw Object.assign(new Error(`${order.payment_method} 官方支付尚未配置完整`), { status: 409, code: 'OFFICIAL_PAYMENT_NOT_READY' });
    const detail = ensureOfficialOrder(order, provider, context.clientIp);
    let payUrl = order.pay_url || '';
    try {
      if (provider === 'wechat_official') {
        if (!payUrl || !/^https:\/\/wx\.tenpay\.com\//i.test(payUrl)) {
          const created = await wechatClient().createH5Order({
            description: orderSubject(order), outTradeNo: detail.merchant_trade_no,
            notifyUrl: `${publicOrigin}/site/api/official/wechat/notify`, totalCents: order.amount_cents,
            clientIp: detail.client_ip || context.clientIp || '127.0.0.1',
          });
          payUrl = created.payUrl;
        }
      } else if (provider === 'alipay_official') {
        payUrl = `${publicOrigin}/site/api/official/alipay/checkout/${order.id}`;
      } else if (provider === 'paypal_official') {
        if (!detail.provider_order_id || !payUrl) {
          const created = await paypalClient().createOrder({
            referenceId: `order-${order.id}`,
            description: orderSubject(order),
            amountCents: order.amount_cents,
            returnUrl: `${publicOrigin}/site/api/official/paypal/return/${order.id}`,
            cancelUrl: `${publicOrigin}/site/api/official/paypal/cancel/${order.id}`,
          });
          payUrl = created.payUrl;
          db.prepare('UPDATE official_payment_orders SET provider_order_id=?,updated_at=? WHERE order_id=?')
            .run(created.providerOrderId, nowIso(), order.id);
        }
      }
      db.prepare('UPDATE membership_orders SET pay_url=? WHERE id=?').run(payUrl, order.id);
      return orderRow(order.id);
    } catch (error) {
      db.prepare("UPDATE official_payment_orders SET status='error',last_error=?,updated_at=? WHERE order_id=?")
        .run(clean(error?.message || error, 500), nowIso(), order.id);
      throw error;
    }
  }

  function paymentMethod(code) {
    return db.prepare('SELECT * FROM payment_methods WHERE code=?').get(code);
  }
  function updateMethod(code, input) {
    if (!PAYMENT_CODES.has(code)) throw Object.assign(new Error('官方支付方式不存在'), { status: 404, code: 'OFFICIAL_PAYMENT_NOT_FOUND' });
    const current = paymentMethod(code);
    if (!current) throw Object.assign(new Error('支付方式不存在'), { status: 404, code: 'PAYMENT_METHOD_NOT_FOUND' });
    const enabled = input.enabled === undefined ? current.enabled : (input.enabled ? 1 : 0);
    const instructions = input.instructions === undefined ? current.instructions : clean(input.instructions, 1000);
    db.prepare('UPDATE payment_methods SET enabled=?,instructions=?,updated_at=? WHERE code=?').run(enabled, instructions, nowIso(), code);
    if (code === 'wechat' || code === 'alipay') {
      const allowed = code === 'wechat' ? new Set(['manual', 'zpay', 'wechat_official']) : new Set(['manual', 'zpay', 'alipay_official']);
      if (input.provider !== undefined) {
        const provider = String(input.provider);
        if (!allowed.has(provider)) throw Object.assign(new Error('支付提供方无效'), { status: 400, code: 'INVALID_PAYMENT_PROVIDER' });
        setSetting(`payment_provider_${code}`, provider);
      }
    }
  }

  function clearCredentials(code) {
    if (code === 'wechat') {
      for (const key of ['wechat_official_merchant_private_key', 'wechat_official_api_v3_key', 'wechat_official_platform_public_key']) setSecure(key, '');
      for (const key of ['wechat_official_app_id', 'wechat_official_mch_id', 'wechat_official_merchant_serial', 'wechat_official_platform_serial']) setSetting(key, '');
    } else if (code === 'alipay') {
      for (const key of ['alipay_official_app_private_key', 'alipay_official_public_key']) setSecure(key, '');
      setSetting('alipay_official_app_id', '');
    } else if (code === 'paypal') {
      setSetting('paypal_official_client_id', '');
      setSecure('paypal_official_client_secret', '');
    }
    providerStatus[code].lastError = '';
  }

  async function saveOfficialConfig(code, input) {
    updateMethod(code, input);
    if (input.clearCredentials === true) clearCredentials(code);
    if (code === 'wechat') {
      if (input.appId !== undefined) setSetting('wechat_official_app_id', clean(input.appId, 128));
      if (input.mchId !== undefined) setSetting('wechat_official_mch_id', clean(input.mchId, 64));
      if (input.merchantSerialNo !== undefined) setSetting('wechat_official_merchant_serial', clean(input.merchantSerialNo, 128));
      if (input.platformSerialNo !== undefined) setSetting('wechat_official_platform_serial', clean(input.platformSerialNo, 128));
      if (input.merchantPrivateKeyPem) setSecure('wechat_official_merchant_private_key', String(input.merchantPrivateKeyPem).slice(0, 16 * 1024));
      if (input.apiV3Key) {
        if (String(input.apiV3Key).length !== 32) throw Object.assign(new Error('微信支付 APIv3 Key 必须为 32 个字符'), { status: 400, code: 'INVALID_WECHAT_API_V3_KEY' });
        setSecure('wechat_official_api_v3_key', String(input.apiV3Key));
      }
      if (input.platformPublicKeyPem) setSecure('wechat_official_platform_public_key', String(input.platformPublicKeyPem).slice(0, 16 * 1024));
    } else if (code === 'alipay') {
      if (input.appId !== undefined) setSetting('alipay_official_app_id', clean(input.appId, 128));
      if (input.sandbox !== undefined) setSetting('alipay_official_sandbox', input.sandbox ? '1' : '0');
      if (input.appPrivateKeyPem) setSecure('alipay_official_app_private_key', String(input.appPrivateKeyPem).slice(0, 16 * 1024));
      if (input.alipayPublicKeyPem) setSecure('alipay_official_public_key', String(input.alipayPublicKeyPem).slice(0, 16 * 1024));
    } else if (code === 'paypal') {
      if (input.clientId !== undefined && String(input.clientId).trim()) setSetting('paypal_official_client_id', clean(input.clientId, 256));
      if (input.clientSecret) setSecure('paypal_official_client_secret', String(input.clientSecret).slice(0, 1024));
      if (input.sandbox !== undefined) setSetting('paypal_official_sandbox', input.sandbox ? '1' : '0');
      if (input.currency !== undefined) {
        const currency = clean(input.currency, 3).toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) throw Object.assign(new Error('PayPal 币种必须是 3 位 ISO-4217 代码'), { status: 400, code: 'INVALID_PAYPAL_CURRENCY' });
        setSetting('paypal_official_currency', currency);
      }
      setSetting('payment_provider_paypal', 'paypal_official');
    }
    return publicConfig(code);
  }

  async function testProvider(code) {
    providerStatus[code].lastTestAt = nowIso();
    try {
      let result;
      if (code === 'wechat') result = await wechatClient().testConnection();
      else if (code === 'alipay') result = alipayClient().selfTest();
      else result = await paypalClient().testConnection();
      providerStatus[code].lastError = '';
      return result;
    } catch (error) {
      providerStatus[code].lastError = clean(error?.message || error, 500);
      throw error;
    }
  }

  async function handleAdmin(req, res, url) {
    if (!url.pathname.startsWith('/admin/api/official-payments')) return false;
    try {
      if (url.pathname === '/admin/api/official-payments' && req.method === 'GET') {
        writeJson(res, 200, { ok: true, wechat: publicConfig('wechat'), alipay: publicConfig('alipay'), paypal: publicConfig('paypal') });
        return true;
      }
      const match = url.pathname.match(/^\/admin\/api\/official-payments\/(wechat|alipay|paypal)$/);
      if (match && req.method === 'PUT') {
        const input = await readJson(req);
        const config = await saveOfficialConfig(match[1], input);
        writeJson(res, 200, { ok: true, config });
        return true;
      }
      const testMatch = url.pathname.match(/^\/admin\/api\/official-payments\/(wechat|alipay|paypal)\/test$/);
      if (testMatch && req.method === 'POST') {
        const result = await testProvider(testMatch[1]);
        writeJson(res, 200, { ok: true, result, config: publicConfig(testMatch[1]) });
        return true;
      }
      writeJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '官方支付配置接口不存在' } });
      return true;
    } catch (error) {
      writeJson(res, error.status || 500, { ok: false, error: { code: error.code || 'OFFICIAL_PAYMENT_ERROR', message: error.status ? error.message : '官方支付配置处理失败' } });
      return true;
    }
  }

  async function handleWechatNotify(req, res) {
    const raw = await readRaw(req);
    const { transaction } = wechatClient().verifyNotification(req.headers, raw);
    const detail = db.prepare("SELECT * FROM official_payment_orders WHERE provider='wechat_official' AND merchant_trade_no=?").get(clean(transaction.out_trade_no, 32));
    if (!detail) throw Object.assign(new Error('微信支付订单号不存在'), { status: 404, code: 'WECHAT_ORDER_NOT_FOUND' });
    const config = wechatConfig();
    if (transaction.trade_state !== 'SUCCESS') throw Object.assign(new Error('微信支付交易尚未成功'), { status: 409, code: 'WECHAT_NOT_PAID' });
    if (String(transaction.mchid || '') !== config.mchId || String(transaction.appid || '') !== config.appId) throw Object.assign(new Error('微信支付商户身份不匹配'), { status: 400, code: 'WECHAT_MERCHANT_MISMATCH' });
    if (Number(transaction.amount?.total) !== Number(detail.amount_cents) || String(transaction.amount?.currency || 'CNY') !== 'CNY') throw Object.assign(new Error('微信支付金额或币种不匹配'), { status: 400, code: 'WECHAT_AMOUNT_MISMATCH' });
    await settleOfficial(detail, { source: 'wechat_official', tradeNo: clean(transaction.transaction_id, 240), amountCents: detail.amount_cents, currency: 'CNY' });
    writeJson(res, 200, { code: 'SUCCESS', message: '成功' });
  }

  async function handleAlipayNotify(req, res) {
    const raw = await readRaw(req);
    const params = alipayClient().verifyNotification(new URLSearchParams(raw));
    const detail = db.prepare("SELECT * FROM official_payment_orders WHERE provider='alipay_official' AND merchant_trade_no=?").get(clean(params.out_trade_no, 64));
    if (!detail) throw Object.assign(new Error('支付宝订单号不存在'), { status: 404, code: 'ALIPAY_ORDER_NOT_FOUND' });
    const config = alipayConfig();
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(String(params.trade_status))) throw Object.assign(new Error('支付宝交易尚未成功'), { status: 409, code: 'ALIPAY_NOT_PAID' });
    if (String(params.app_id || '') !== config.appId) throw Object.assign(new Error('支付宝 AppID 不匹配'), { status: 400, code: 'ALIPAY_APP_ID_MISMATCH' });
    if (centsFromDecimal(params.total_amount) !== Number(detail.amount_cents)) throw Object.assign(new Error('支付宝回调金额不匹配'), { status: 400, code: 'ALIPAY_AMOUNT_MISMATCH' });
    await settleOfficial(detail, { source: 'alipay_official', tradeNo: clean(params.trade_no, 240), amountCents: detail.amount_cents, currency: 'CNY' });
    writeText(res, 200, 'success');
  }

  async function handlePayPalReturn(res, orderId, url) {
    const detail = officialOrder(orderId);
    const order = orderRow(orderId);
    if (!detail || detail.provider !== 'paypal_official' || !order) throw Object.assign(new Error('PayPal 订单不存在'), { status: 404, code: 'PAYPAL_ORDER_NOT_FOUND' });
    if (detail.status === 'settled' || order.status === 'paid') {
      res.writeHead(302, { location: `${publicOrigin}/account?paypal=success`, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const token = clean(url.searchParams.get('token'), 256);
    if (!token || token !== detail.provider_order_id) throw Object.assign(new Error('PayPal 返回订单号不匹配'), { status: 400, code: 'PAYPAL_ORDER_ID_MISMATCH' });
    const result = await paypalClient().captureOrder(detail.provider_order_id);
    if (result.status !== 'COMPLETED') throw Object.assign(new Error('PayPal 订单尚未完成'), { status: 409, code: 'PAYPAL_NOT_COMPLETED' });
    const unit = (result.purchase_units || []).find((item) => item.reference_id === `order-${order.id}`) || result.purchase_units?.[0];
    const capture = unit?.payments?.captures?.find((item) => item.status === 'COMPLETED') || unit?.payments?.captures?.[0];
    const config = paypalConfig();
    if (!unit || unit.reference_id !== `order-${order.id}` || !capture || capture.status !== 'COMPLETED') throw Object.assign(new Error('PayPal 完成订单缺少可信 Capture'), { status: 502, code: 'PAYPAL_CAPTURE_MISSING' });
    if (String(capture.amount?.currency_code || '') !== config.currency || centsFromDecimal(capture.amount?.value) !== Number(detail.amount_cents)) throw Object.assign(new Error('PayPal Capture 金额或币种不匹配'), { status: 400, code: 'PAYPAL_AMOUNT_MISMATCH' });
    await settleOfficial(detail, { source: 'paypal_official', tradeNo: clean(capture.id, 240), amountCents: detail.amount_cents, currency: config.currency });
    res.writeHead(302, { location: `${publicOrigin}/account?paypal=success`, 'cache-control': 'no-store' });
    res.end();
  }

  async function handleSite(req, res, url) {
    if (!url.pathname.startsWith('/site/api/official/')) return false;
    try {
      if (url.pathname === '/site/api/official/wechat/notify' && req.method === 'POST') {
        await handleWechatNotify(req, res);
        return true;
      }
      if (url.pathname === '/site/api/official/alipay/notify' && req.method === 'POST') {
        await handleAlipayNotify(req, res);
        return true;
      }
      const alipayCheckout = url.pathname.match(/^\/site\/api\/official\/alipay\/checkout\/(\d+)$/);
      if (alipayCheckout && req.method === 'GET') {
        const order = orderRow(Number(alipayCheckout[1]));
        const detail = officialOrder(Number(alipayCheckout[1]));
        if (!order || !detail || detail.provider !== 'alipay_official' || order.status !== 'pending') throw Object.assign(new Error('支付宝待支付订单不存在'), { status: 404, code: 'ALIPAY_ORDER_NOT_FOUND' });
        const form = alipayClient().createPagePayForm({
          outTradeNo: detail.merchant_trade_no,
          subject: orderSubject(order),
          totalAmount: Number(order.amount_cents) / 100,
          notifyUrl: `${publicOrigin}/site/api/official/alipay/notify`,
          returnUrl: `${publicOrigin}/site/api/official/alipay/return/${order.id}`,
        });
        const nonce = randomBytes(18).toString('base64url');
        const fields = Object.entries(form.params).map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`).join('');
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在前往支付宝</title></head><body><main><p>正在前往支付宝官方收银台…</p><form id="pay" method="post" action="${htmlEscape(form.gateway)}">${fields}<button type="submit">继续支付</button></form></main><script nonce="${nonce}">document.getElementById('pay').submit();</script></body></html>`;
        const payload = Buffer.from(html, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${new URL(form.gateway).origin}; base-uri 'none'; frame-ancestors 'none'`,
          'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
        });
        res.end(payload);
        return true;
      }
      const alipayReturn = url.pathname.match(/^\/site\/api\/official\/alipay\/return\/(\d+)$/);
      if (alipayReturn && req.method === 'GET') {
        res.writeHead(302, { location: `${publicOrigin}/account?alipay=pending`, 'cache-control': 'no-store' });
        res.end();
        return true;
      }
      const paypalReturn = url.pathname.match(/^\/site\/api\/official\/paypal\/return\/(\d+)$/);
      if (paypalReturn && req.method === 'GET') {
        await handlePayPalReturn(res, Number(paypalReturn[1]), url);
        return true;
      }
      const paypalCancel = url.pathname.match(/^\/site\/api\/official\/paypal\/cancel\/(\d+)$/);
      if (paypalCancel && req.method === 'GET') {
        res.writeHead(302, { location: `${publicOrigin}/account?paypal=cancelled`, 'cache-control': 'no-store' });
        res.end();
        return true;
      }
      return false;
    } catch (error) {
      logger.warn?.('GPTWork official payment callback rejected:', error.code || '', error.message);
      if (url.pathname.includes('/wechat/notify')) writeJson(res, error.status || 500, { code: 'FAIL', message: error.status ? error.message : '处理失败' });
      else if (url.pathname.includes('/alipay/notify')) writeText(res, error.status || 500, 'fail');
      else if (url.pathname.includes('/paypal/return/')) {
        res.writeHead(302, { location: `${publicOrigin}/account?paypal=failed`, 'cache-control': 'no-store' });
        res.end();
      } else writeText(res, error.status || 500, error.status ? error.message : 'Official payment failed');
      return true;
    }
  }

  function attachSettlement(handler) { settleOrderById = typeof handler === 'function' ? handler : null; }
  function orderDetails(orderId) {
    const row = officialOrder(orderId);
    if (!row) return null;
    return {
      provider: row.provider, merchantTradeNo: row.merchant_trade_no, providerOrderId: row.provider_order_id,
      tradeNo: row.provider_trade_no, status: row.status, currency: row.currency, paidAt: row.paid_at, lastError: row.last_error,
    };
  }

  return {
    handleAdmin,
    handleSite,
    enrichList,
    prepareOrder,
    attachSettlement,
    orderDetails,
    publicConfig,
    providerFor,
  };
}
