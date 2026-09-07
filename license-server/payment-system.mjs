import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { createOkxClient, OKX_DEFAULT_BASE_URL } from './okx-client.mjs';
import { createZpayClient, centsFromZpayMoney, verifyZpaySignature, zpayMoneyFromCents, zpaySign, ZPAY_SUBMIT_URL } from './zpay-client.mjs';

const MAX_QR_BYTES = 1024 * 1024;
const MAX_PAYMENT_BODY = 2 * 1024 * 1024;
const PAYMENT_CODES = new Set(['wechat', 'alipay', 'usdt']);
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const USDT_SCALE = 1_000_000;
const MATCH_CLOCK_SKEW_MS = 2 * 60 * 1000;
const MATCH_COMPLETION_GRACE_MS = 15 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }
function normalizeHttpsUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 2048) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch { return null; }
}
function cleanText(value, max) { return String(value || '').trim().slice(0, max); }
function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function parseUsdtMicros(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^\d{1,9}(?:\.\d{1,6})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const micros = Number(whole) * USDT_SCALE + Number(fraction.padEnd(6, '0'));
  return Number.isSafeInteger(micros) && micros > 0 && micros <= 1_000_000_000 * USDT_SCALE ? micros : null;
}
function formatUsdtMicros(value) {
  const micros = Number(value || 0);
  if (!Number.isSafeInteger(micros) || micros <= 0) return '';
  const whole = Math.floor(micros / USDT_SCALE);
  const fraction = String(micros % USDT_SCALE).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
function sameText(left, right) { return cleanText(left, 512).toLowerCase() === cleanText(right, 512).toLowerCase(); }

function ensurePaymentMethodsSchema(db) {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='payment_methods'").get();
  if (!row) {
    db.exec(`
      CREATE TABLE payment_methods (
        code TEXT PRIMARY KEY CHECK(code IN ('wechat','alipay','usdt')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        pay_url TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    return;
  }
  if (!/CHECK\s*\(\s*code\s+IN\s*\(\s*'wechat'\s*,\s*'alipay'\s*\)\s*\)/i.test(String(row.sql || ''))) return;

  const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys || 0);
  if (foreignKeys) db.exec('PRAGMA foreign_keys=OFF;');
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE payment_methods_v2 (
        code TEXT PRIMARY KEY CHECK(code IN ('wechat','alipay','usdt')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        pay_url TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO payment_methods_v2(code,name,enabled,pay_url,instructions,updated_at)
        SELECT code,name,enabled,pay_url,instructions,updated_at FROM payment_methods;
      DROP TABLE payment_methods;
      ALTER TABLE payment_methods_v2 RENAME TO payment_methods;
      COMMIT;
    `);
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  } finally {
    if (foreignKeys) db.exec('PRAGMA foreign_keys=ON;');
  }
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) throw new Error(`payment_methods migration created ${violations.length} foreign key violation(s)`);
}

async function readJson(req, maxBytes = MAX_PAYMENT_BODY) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('上传内容过大'), { status: 413, code: 'PAYMENT_BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求 JSON 无效'), { status: 400, code: 'INVALID_JSON' }); }
}

function decodeDataUrl(value) {
  const match = String(value || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw Object.assign(new Error('二维码图片仅支持 PNG、JPEG 或 WebP'), { status: 400, code: 'INVALID_QR_IMAGE' });
  const mime = match[1].toLowerCase();
  if (!IMAGE_MIME.has(mime)) throw Object.assign(new Error('二维码图片格式不支持'), { status: 400, code: 'INVALID_QR_IMAGE' });
  const blob = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!blob.length || blob.length > MAX_QR_BYTES) throw Object.assign(new Error('二维码图片必须小于 1 MB'), { status: 413, code: 'QR_IMAGE_TOO_LARGE' });
  return { mime, blob };
}

export function createPaymentSystem({ db, publicOrigin, json, secret = '', env = process.env, fetchImpl = globalThis.fetch, logger = console }) {
  ensurePaymentMethodsSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_method_details (
      code TEXT PRIMARY KEY REFERENCES payment_methods(code) ON DELETE CASCADE,
      qr_mime TEXT NOT NULL DEFAULT '',
      qr_blob BLOB,
      crypto_asset TEXT NOT NULL DEFAULT '',
      crypto_network TEXT NOT NULL DEFAULT '',
      crypto_address TEXT NOT NULL DEFAULT '',
      crypto_memo TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    ) STRICT;
  `);

  const insertMethod = db.prepare(`INSERT OR IGNORE INTO payment_methods(code,name,enabled,pay_url,instructions,updated_at) VALUES(?,?,?,?,?,?)`);
  insertMethod.run('wechat', '微信支付 / WeChat Pay', 0, '', '请扫码付款；付款完成后等待管理员确认到账。', nowIso());
  insertMethod.run('alipay', '支付宝 / Alipay', 0, '', '请扫码付款；付款完成后等待管理员确认到账。', nowIso());
  insertMethod.run('usdt', 'USDT / Tether', 0, '', '请按订单显示的精确 USDT 数量付款；服务端会通过 OKX 只读 API 核对到账并自动开通。', nowIso());
  const insertDetail = db.prepare(`INSERT OR IGNORE INTO payment_method_details(code,crypto_asset,updated_at) VALUES(?,?,?)`);
  insertDetail.run('wechat', '', nowIso());
  insertDetail.run('alipay', '', nowIso());
  insertDetail.run('usdt', 'USDT', nowIso());

  let runtimeReady = false;
  let settleOrderById = null;
  let pollTimer = null;
  let startupTimer = null;
  let checking = false;
  const status = { lastCheckAt: null, lastSuccessAt: null, lastError: '', lastMatchedOrderId: null };
  const zpayStatus = { lastTestAt: null, lastError: '' };
  const CONFIG_KEY = secret ? createHmac('sha256', secret).update('gptlock-okx-payment-settings:v1').digest() : null;

  function ensureRuntimeTables() {
    if (runtimeReady) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS secure_settings (
        key TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS payment_plan_prices (
        plan_code TEXT NOT NULL,
        payment_code TEXT NOT NULL CHECK(payment_code IN ('usdt')),
        amount_micros INTEGER NOT NULL CHECK(amount_micros > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plan_code,payment_code)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS usdt_order_payments (
        order_id INTEGER PRIMARY KEY REFERENCES membership_orders(id) ON DELETE CASCADE,
        expected_amount_micros INTEGER NOT NULL CHECK(expected_amount_micros > 0),
        asset TEXT NOT NULL DEFAULT 'USDT',
        network TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        memo TEXT NOT NULL DEFAULT '',
        match_status TEXT NOT NULL DEFAULT 'awaiting' CHECK(match_status IN ('awaiting','confirming','ambiguous','settled','error')),
        okx_deposit_id TEXT NOT NULL DEFAULT '',
        okx_tx_id TEXT NOT NULL DEFAULT '',
        okx_state TEXT NOT NULL DEFAULT '',
        matched_at TEXT,
        last_checked_at TEXT,
        last_error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usdt_payment_dep_id ON usdt_order_payments(okx_deposit_id) WHERE okx_deposit_id<>'';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usdt_payment_tx_id ON usdt_order_payments(okx_tx_id) WHERE okx_tx_id<>'';
      CREATE TABLE IF NOT EXISTS zpay_order_payments (
        order_id INTEGER PRIMARY KEY REFERENCES membership_orders(id) ON DELETE CASCADE,
        merchant_trade_no TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL CHECK(channel IN ('alipay','wxpay')),
        amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
        client_ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        zpay_trade_no TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'awaiting' CHECK(status IN ('awaiting','settled','error')),
        paid_at TEXT,
        last_error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_zpay_trade_no ON zpay_order_payments(zpay_trade_no) WHERE zpay_trade_no<>'';
    `);
    runtimeReady = true;
  }

  function getSetting(key, fallback = '') {
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    return row ? row.value : fallback;
  }
  function setSetting(key, value) {
    db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(value), nowIso());
  }
  function encryptSetting(value, keyName) {
    if (!CONFIG_KEY) throw Object.assign(new Error('服务端密钥不可用，无法保存 OKX 凭据'), { status: 500, code: 'PAYMENT_SECRET_UNAVAILABLE' });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', CONFIG_KEY, iv);
    cipher.setAAD(Buffer.from(`gptlock-okx-setting:v1:${keyName}`));
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
  }
  function decryptSetting(value, keyName) {
    if (!value || !CONFIG_KEY) return '';
    try {
      const [version, ivText, tagText, dataText] = String(value).split('.');
      if (version !== 'v1') return '';
      const decipher = createDecipheriv('aes-256-gcm', CONFIG_KEY, Buffer.from(ivText, 'base64url'));
      decipher.setAAD(Buffer.from(`gptlock-okx-setting:v1:${keyName}`));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
    } catch { return ''; }
  }
  function setSecureSetting(key, value) {
    ensureRuntimeTables();
    if (!value) return db.prepare('DELETE FROM secure_settings WHERE key=?').run(key);
    db.prepare(`INSERT INTO secure_settings(key,ciphertext,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`).run(key, encryptSetting(value, key), nowIso());
  }
  function getSecureSetting(key) {
    ensureRuntimeTables();
    const row = db.prepare('SELECT ciphertext FROM secure_settings WHERE key=?').get(key);
    return row ? decryptSetting(row.ciphertext, key) : '';
  }

  function okxConfig() {
    const apiKey = getSecureSetting('okx_api_key');
    const secretKey = getSecureSetting('okx_secret_key');
    const passphrase = getSecureSetting('okx_passphrase');
    return {
      enabled: getSetting('okx_auto_settlement_enabled', '0') === '1',
      configured: Boolean(apiKey && secretKey && passphrase),
      apiKey, secretKey, passphrase,
      pollSeconds: clampInt(getSetting('okx_poll_seconds', '15'), 10, 300, 15),
      orderTtlMinutes: clampInt(getSetting('usdt_order_ttl_minutes', '120'), 30, 720, 120),
      allowInternalTransfers: getSetting('okx_allow_internal_transfers', '1') !== '0',
      apiKeyHint: apiKey ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : '',
      baseUrl: OKX_DEFAULT_BASE_URL,
    };
  }

  function paymentProvider(code) {
    if (!['wechat', 'alipay'].includes(code)) return code === 'usdt' ? 'okx' : 'manual';
    const value = getSetting(`payment_provider_${code}`, 'manual');
    return value === 'zpay' ? 'zpay' : 'manual';
  }
  function cleanChannelIds(value) {
    const raw = cleanText(value, 240).replace(/\s+/g, '');
    if (!raw) return '';
    if (!/^\d+(?:,\d+)*$/.test(raw)) throw Object.assign(new Error('ZPAY 支付渠道 ID 只能填写数字，多个 ID 使用英文逗号分隔'), { status: 400, code: 'INVALID_ZPAY_CID' });
    return raw;
  }
  function zpayConfig() {
    const pid = getSetting('zpay_pid', '');
    const key = getSecureSetting('zpay_key');
    return {
      enabled: getSetting('zpay_enabled', '0') === '1',
      configured: Boolean(pid && key),
      pid,
      key,
      pidHint: pid ? `${pid.slice(0, 4)}…${pid.slice(-4)}` : '',
      alipayCid: getSetting('zpay_alipay_cid', ''),
      wechatCid: getSetting('zpay_wechat_cid', ''),
      submitUrl: ZPAY_SUBMIT_URL,
    };
  }
  function zpayChannelForPayment(code) {
    return code === 'alipay' ? 'alipay' : code === 'wechat' ? 'wxpay' : '';
  }
  function zpayAvailableForPayment(code) {
    if (paymentProvider(code) !== 'zpay') return false;
    const config = zpayConfig();
    return Boolean(config.enabled && config.configured && zpayChannelForPayment(code));
  }
  function zpayClient() {
    const config = zpayConfig();
    if (!config.configured) throw Object.assign(new Error('ZPAY 商户 ID / 商户密钥尚未配置完整'), { status: 409, code: 'ZPAY_NOT_CONFIGURED' });
    return createZpayClient({ pid: config.pid, key: config.key, fetchImpl });
  }
  function createZpayTradeNo(orderId) {
    const base = `${Date.now()}${String(Number(orderId)).padStart(10, '0')}`;
    return base.slice(0, 32);
  }
  function zpayOrderDetails(orderId) {
    ensureRuntimeTables();
    const row = db.prepare('SELECT * FROM zpay_order_payments WHERE order_id=?').get(Number(orderId));
    if (!row) return null;
    return {
      provider: 'zpay', merchantTradeNo: row.merchant_trade_no, tradeNo: row.zpay_trade_no || '',
      channel: row.channel, status: row.status, paidAt: row.paid_at, lastError: row.last_error || '',
    };
  }
  function prepareOrder(order, context = {}) {
    if (!order || !['wechat', 'alipay'].includes(order.payment_method) || paymentProvider(order.payment_method) !== 'zpay') return order;
    ensureRuntimeTables();
    if (!zpayAvailableForPayment(order.payment_method)) {
      throw Object.assign(new Error('ZPAY 尚未启用或商户凭据未配置完整'), { status: 409, code: 'ZPAY_NOT_READY' });
    }
    const existing = db.prepare('SELECT * FROM zpay_order_payments WHERE order_id=?').get(order.id);
    if (!existing) {
      const channel = zpayChannelForPayment(order.payment_method);
      let tradeNo = createZpayTradeNo(order.id);
      while (db.prepare('SELECT 1 FROM zpay_order_payments WHERE merchant_trade_no=?').get(tradeNo)) {
        tradeNo = `${Date.now()}${String(order.id).padStart(10, '0')}`.slice(0, 32);
      }
      db.prepare(`INSERT INTO zpay_order_payments(order_id,merchant_trade_no,channel,amount_cents,client_ip,user_agent,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run(order.id, tradeNo, channel, Number(order.amount_cents), cleanText(context.clientIp, 64), cleanText(context.userAgent, 240), nowIso());
    }
    const payUrl = `${publicOrigin}/site/api/zpay/checkout/${order.id}`;
    db.prepare('UPDATE membership_orders SET pay_url=? WHERE id=?').run(payUrl, order.id);
    return db.prepare('SELECT * FROM membership_orders WHERE id=?').get(order.id);
  }
  function zpayCheckoutParams(orderId) {
    ensureRuntimeTables();
    const detail = db.prepare(`SELECT z.*,o.status AS order_status,o.amount_cents,o.plan_snapshot_json
      FROM zpay_order_payments z JOIN membership_orders o ON o.id=z.order_id WHERE z.order_id=?`).get(Number(orderId));
    if (!detail) throw Object.assign(new Error('ZPAY 订单不存在'), { status: 404, code: 'ZPAY_ORDER_NOT_FOUND' });
    if (detail.order_status !== 'pending') throw Object.assign(new Error('该订单已不是待支付状态'), { status: 409, code: 'ORDER_NOT_PENDING' });
    const config = zpayConfig();
    if (!config.enabled || !config.configured) throw Object.assign(new Error('ZPAY 当前不可用'), { status: 409, code: 'ZPAY_NOT_READY' });
    let snapshot = {};
    try { snapshot = JSON.parse(detail.plan_snapshot_json || '{}'); } catch {}
    const planName = cleanText(snapshot.name || snapshot.code || '会员', 60).replace(/[<>]/g, '');
    const params = {
      pid: config.pid,
      type: detail.channel,
      out_trade_no: detail.merchant_trade_no,
      notify_url: `${publicOrigin}/site/api/zpay/notify`,
      return_url: `${publicOrigin}/site/api/zpay/return`,
      name: `GPTWork ${planName} 会员服务`.slice(0, 100),
      money: zpayMoneyFromCents(detail.amount_cents),
      param: `order-${detail.order_id}`,
    };
    const cid = detail.channel === 'alipay' ? config.alipayCid : config.wechatCid;
    if (cid) params.cid = cid;
    params.sign = zpaySign(params, config.key);
    params.sign_type = 'MD5';
    return params;
  }
  function htmlEscape(value) {
    return String(value).replace(/[&<>\"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[char]);
  }
  function writePlain(res, statusCode, value) {
    const payload = Buffer.from(String(value), 'utf8');
    res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(payload);
  }
  async function settleZpayCallback(url) {
    ensureRuntimeTables();
    const config = zpayConfig();
    if (!config.configured) throw Object.assign(new Error('ZPAY 凭据未配置'), { status: 503, code: 'ZPAY_NOT_CONFIGURED' });
    if (!verifyZpaySignature(url.searchParams, config.key)) throw Object.assign(new Error('ZPAY 回调签名校验失败'), { status: 400, code: 'ZPAY_BAD_SIGNATURE' });
    if (url.searchParams.get('pid') !== config.pid) throw Object.assign(new Error('ZPAY 回调商户 ID 不匹配'), { status: 400, code: 'ZPAY_PID_MISMATCH' });
    if (url.searchParams.get('trade_status') !== 'TRADE_SUCCESS') throw Object.assign(new Error('ZPAY 回调尚未支付成功'), { status: 409, code: 'ZPAY_NOT_PAID' });
    const merchantTradeNo = cleanText(url.searchParams.get('out_trade_no'), 32);
    const detail = db.prepare(`SELECT z.*,o.status AS order_status,o.amount_cents,o.payment_method
      FROM zpay_order_payments z JOIN membership_orders o ON o.id=z.order_id WHERE z.merchant_trade_no=?`).get(merchantTradeNo);
    if (!detail) throw Object.assign(new Error('ZPAY 商户订单号不存在'), { status: 404, code: 'ZPAY_ORDER_NOT_FOUND' });
    const callbackCents = centsFromZpayMoney(url.searchParams.get('money'));
    if (callbackCents === null || callbackCents !== Number(detail.amount_cents)) throw Object.assign(new Error('ZPAY 回调金额与订单金额不一致'), { status: 400, code: 'ZPAY_AMOUNT_MISMATCH' });
    if (url.searchParams.get('type') !== detail.channel) throw Object.assign(new Error('ZPAY 回调支付渠道不匹配'), { status: 400, code: 'ZPAY_CHANNEL_MISMATCH' });
    if (detail.status === 'settled' || detail.order_status === 'paid') return detail.order_id;
    if (!settleOrderById) throw Object.assign(new Error('会员自动开通回调尚未就绪'), { status: 503, code: 'SETTLEMENT_NOT_READY' });
    const providerTradeNo = cleanText(url.searchParams.get('trade_no'), 160);
    try {
      await Promise.resolve(settleOrderById(detail.order_id, {
        source: 'zpay_auto', tradeNo: providerTradeNo, merchantTradeNo, channel: detail.channel, amount: url.searchParams.get('money') || '',
      }));
      const paidAt = nowIso();
      db.prepare(`UPDATE zpay_order_payments SET zpay_trade_no=?,status='settled',paid_at=?,last_error='',updated_at=? WHERE order_id=?`)
        .run(providerTradeNo, paidAt, paidAt, detail.order_id);
      return detail.order_id;
    } catch (error) {
      db.prepare(`UPDATE zpay_order_payments SET status='error',last_error=?,updated_at=? WHERE order_id=?`)
        .run(cleanText(error?.message || error, 500), nowIso(), detail.order_id);
      throw error;
    }
  }

  function method(code, enabledOnly = false) {
    if (!PAYMENT_CODES.has(code)) return null;
    return db.prepare(`SELECT p.*,d.qr_mime,d.qr_blob,d.crypto_asset,d.crypto_network,d.crypto_address,d.crypto_memo
      FROM payment_methods p LEFT JOIN payment_method_details d ON d.code=p.code
      WHERE p.code=?${enabledOnly ? ' AND p.enabled=1' : ''}`).get(code);
  }
  function planPriceMap() {
    ensureRuntimeTables();
    const rows = db.prepare("SELECT plan_code,amount_micros FROM payment_plan_prices WHERE payment_code='usdt'").all();
    return Object.fromEntries(rows.map((row) => [row.plan_code, formatUsdtMicros(row.amount_micros)]));
  }
  function publicMethod(row) {
    const provider = paymentProvider(row.code);
    const zpay = provider === 'zpay' ? zpayConfig() : null;
    const qrConfigured = provider === 'zpay' ? false : Boolean(row?.qr_blob && row?.qr_mime);
    const config = row.code === 'usdt' ? okxConfig() : null;
    return {
      code: row.code,
      name: row.name,
      enabled: Boolean(row.enabled),
      provider,
      payUrl: provider === 'zpay' ? '' : (row.pay_url || ''),
      instructions: row.instructions || '',
      qrConfigured,
      qrUrl: qrConfigured ? `${publicOrigin}/site/api/payment-qr/${row.code}` : '',
      crypto: row.code === 'usdt' ? {
        asset: row.crypto_asset || 'USDT',
        network: row.crypto_network || '',
        address: row.crypto_address || '',
        memo: row.crypto_memo || '',
      } : null,
      planPrices: row.code === 'usdt' ? planPriceMap() : null,
      autoConfirm: row.code === 'usdt' ? Boolean(config.enabled && config.configured) : (provider === 'zpay' ? Boolean(zpay.enabled && zpay.configured) : false),
    };
  }
  function list(enabledOnly = false) {
    const methods = db.prepare(`SELECT p.*,d.qr_mime,d.qr_blob,d.crypto_asset,d.crypto_network,d.crypto_address,d.crypto_memo
      FROM payment_methods p LEFT JOIN payment_method_details d ON d.code=p.code
      ${enabledOnly ? 'WHERE p.enabled=1' : ''}
      ORDER BY CASE p.code WHEN 'wechat' THEN 10 WHEN 'alipay' THEN 20 WHEN 'usdt' THEN 30 ELSE 99 END,p.code`).all().map(publicMethod);
    return enabledOnly ? methods.filter((item) => item.provider !== 'zpay' || item.autoConfirm) : methods;
  }
  function replyFailure(res, error) {
    json(res, error.status || 500, { ok: false, error: { code: error.code || 'PAYMENT_ERROR', message: error.status ? error.message : '支付配置处理失败' } });
  }

  function usdtQuote(planCode) {
    ensureRuntimeTables();
    const row = db.prepare("SELECT amount_micros FROM payment_plan_prices WHERE payment_code='usdt' AND plan_code=?").get(String(planCode || ''));
    if (!row) throw Object.assign(new Error('该会员套餐尚未配置 USDT 价格，请联系管理员'), { status: 409, code: 'USDT_PRICE_NOT_CONFIGURED' });
    return { asset: 'USDT', amountMicros: Number(row.amount_micros), amount: formatUsdtMicros(row.amount_micros) };
  }

  function attachUsdtOrder(orderId, quote = null) {
    ensureRuntimeTables();
    const order = db.prepare("SELECT * FROM membership_orders WHERE id=? AND payment_method='usdt'").get(Number(orderId));
    if (!order) throw Object.assign(new Error('USDT 订单不存在'), { status: 404, code: 'USDT_ORDER_NOT_FOUND' });
    const current = db.prepare('SELECT * FROM usdt_order_payments WHERE order_id=?').get(order.id);
    if (current) return current;
    const price = quote || usdtQuote(order.plan_code);
    const baseAmountMicros = Number(price.amountMicros);
    const reserved = new Set(db.prepare(`SELECT d.expected_amount_micros FROM usdt_order_payments d
      JOIN membership_orders o ON o.id=d.order_id
      WHERE o.status='pending' AND o.payment_method='usdt' AND o.id<>? AND o.expires_at>=?`).all(order.id, order.created_at).map((row) => Number(row.expected_amount_micros)));
    let expectedAmountMicros = null;
    for (let offset = 0; offset <= 999; offset += 1) {
      const candidate = baseAmountMicros + offset;
      if (!reserved.has(candidate)) { expectedAmountMicros = candidate; break; }
    }
    if (!expectedAmountMicros) throw Object.assign(new Error('当前待支付 USDT 订单过多，暂时无法分配唯一付款金额，请稍后重试'), { status: 409, code: 'USDT_AMOUNT_POOL_EXHAUSTED' });
    const details = method('usdt');
    const now = nowIso();
    db.prepare(`INSERT INTO usdt_order_payments(order_id,expected_amount_micros,asset,network,address,memo,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(order.id, expectedAmountMicros, 'USDT', details?.crypto_network || '', details?.crypto_address || '', details?.crypto_memo || '', now);
    return db.prepare('SELECT * FROM usdt_order_payments WHERE order_id=?').get(order.id);
  }

  function orderPaymentDetails(orderId) {
    ensureRuntimeTables();
    const row = db.prepare('SELECT * FROM usdt_order_payments WHERE order_id=?').get(Number(orderId));
    if (!row) return null;
    return {
      asset: row.asset || 'USDT',
      amount: formatUsdtMicros(row.expected_amount_micros),
      network: row.network || '',
      address: row.address || '',
      memo: row.memo || '',
      matchStatus: row.match_status,
      okxState: row.okx_state || '',
      txId: row.okx_tx_id || '',
      depositId: row.okx_deposit_id || '',
      matchedAt: row.matched_at,
      lastCheckedAt: row.last_checked_at,
      lastError: row.last_error || '',
    };
  }

  function usdtOrderTtlMs() { return okxConfig().orderTtlMinutes * 60 * 1000; }

  function createClient() {
    const config = okxConfig();
    if (!config.configured) throw Object.assign(new Error('OKX 只读 API 凭据尚未配置完整'), { status: 409, code: 'OKX_NOT_CONFIGURED' });
    return createOkxClient({
      apiKey: config.apiKey,
      secretKey: config.secretKey,
      passphrase: config.passphrase,
      baseUrl: env.GPTLOCK_OKX_API_BASE || OKX_DEFAULT_BASE_URL,
      fetchImpl,
    });
  }

  function depositMatchesOrder(deposit, row, config) {
    const amountMicros = parseUsdtMicros(deposit?.amt);
    if (!amountMicros || amountMicros !== Number(row.expected_amount_micros)) return false;
    if (String(deposit?.ccy || '').toUpperCase() !== 'USDT') return false;
    const ts = Number(deposit?.ts || 0);
    const createdMs = Date.parse(row.created_at || '');
    const expiresMs = Date.parse(row.expires_at || '');
    if (!Number.isFinite(ts) || !Number.isFinite(createdMs) || !Number.isFinite(expiresMs)) return false;
    if (ts < createdMs - MATCH_CLOCK_SKEW_MS || ts > expiresMs + MATCH_COMPLETION_GRACE_MS) return false;

    const chain = cleanText(deposit?.chain, 80);
    const to = cleanText(deposit?.to, 256);
    const internal = String(deposit?.type || '') === '3' || (!chain && !to);
    if (row.network && chain && !sameText(row.network, chain)) return false;
    if (row.address && to && !sameText(row.address, to)) return false;
    if ((row.network || row.address) && internal && !config.allowInternalTransfers) return false;
    if (row.address && !to && !internal) return false;
    return true;
  }

  function markCandidates(orderIds, matchStatus, okxState, message = '') {
    ensureRuntimeTables();
    const update = db.prepare(`UPDATE usdt_order_payments SET match_status=?,okx_state=?,last_checked_at=?,last_error=?,updated_at=? WHERE order_id=?`);
    const now = nowIso();
    for (const id of orderIds) update.run(matchStatus, String(okxState || ''), now, cleanText(message, 500), now, id);
  }

  function candidateRows() {
    ensureRuntimeTables();
    return db.prepare(`SELECT d.*,o.status AS order_status,o.created_at,o.expires_at,o.payment_method,o.plan_code
      FROM usdt_order_payments d JOIN membership_orders o ON o.id=d.order_id
      WHERE o.payment_method='usdt' AND o.status='pending' AND d.match_status<>'settled'
      ORDER BY o.id ASC`).all();
  }

  function attachLegacyPendingOrders() {
    ensureRuntimeTables();
    const rows = db.prepare(`SELECT o.id,o.plan_code FROM membership_orders o
      LEFT JOIN usdt_order_payments d ON d.order_id=o.id
      WHERE o.payment_method='usdt' AND o.status='pending' AND d.order_id IS NULL`).all();
    for (const row of rows) {
      try { attachUsdtOrder(row.id); }
      catch (error) {
        if (error?.code !== 'USDT_PRICE_NOT_CONFIGURED') logger.warn?.('GPTWork USDT order not attached:', row.id, error.message);
      }
    }
  }

  async function runAutoSettlement({ force = false } = {}) {
    ensureRuntimeTables();
    if (checking) return { ok: true, skipped: 'busy', ...status };
    const config = okxConfig();
    if (!force && (!config.enabled || !config.configured || !settleOrderById)) return { ok: true, skipped: 'disabled', ...status };
    if (!config.configured) throw Object.assign(new Error('OKX 只读 API 凭据尚未配置完整'), { status: 409, code: 'OKX_NOT_CONFIGURED' });
    if (!settleOrderById) throw Object.assign(new Error('自动开通回调尚未就绪'), { status: 503, code: 'SETTLEMENT_NOT_READY' });

    checking = true;
    status.lastCheckAt = nowIso();
    status.lastError = '';
    try {
      attachLegacyPendingOrders();
      const orders = candidateRows();
      if (!orders.length) {
        status.lastSuccessAt = nowIso();
        return { ok: true, checkedOrders: 0, deposits: 0, settled: 0, ...status };
      }
      const deposits = await createClient().getDepositHistory({ ccy: 'USDT', limit: 100 });
      const usedDepositIds = new Set(db.prepare("SELECT okx_deposit_id FROM usdt_order_payments WHERE okx_deposit_id<>''").all().map((row) => row.okx_deposit_id));
      const usedTxIds = new Set(db.prepare("SELECT okx_tx_id FROM usdt_order_payments WHERE okx_tx_id<>''").all().map((row) => row.okx_tx_id));
      const activeOrderIds = new Set(orders.map((row) => row.order_id));
      let settled = 0;
      let ambiguous = 0;

      const orderedDeposits = [...deposits].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
      for (const deposit of orderedDeposits) {
        const depId = cleanText(deposit.depId, 120);
        const txId = cleanText(deposit.txId, 300);
        if ((depId && usedDepositIds.has(depId)) || (txId && usedTxIds.has(txId))) continue;
        const candidates = orders.filter((row) => activeOrderIds.has(row.order_id) && depositMatchesOrder(deposit, row, config));
        if (!candidates.length) continue;
        const stateValue = String(deposit.state || '');
        if (candidates.length > 1) {
          ambiguous += 1;
          markCandidates(candidates.map((row) => row.order_id), 'ambiguous', stateValue, `发现 ${candidates.length} 个订单匹配同一笔 OKX 充值，已停止自动开通，请管理员核对。`);
          continue;
        }
        const candidate = candidates[0];
        if (stateValue !== '2') {
          markCandidates([candidate.order_id], 'confirming', stateValue, stateValue === '1' ? 'OKX 已确认到账，等待充值最终完成。' : '已发现匹配充值，等待区块确认。');
          continue;
        }
        try {
          await Promise.resolve(settleOrderById(candidate.order_id, {
            source: 'okx_auto', depositId: depId, txId, amount: deposit.amt, chain: deposit.chain, depositTs: deposit.ts,
          }));
          const matchedAt = nowIso();
          db.prepare(`UPDATE usdt_order_payments SET match_status='settled',okx_deposit_id=?,okx_tx_id=?,okx_state='2',matched_at=?,last_checked_at=?,last_error='',updated_at=? WHERE order_id=?`)
            .run(depId, txId, matchedAt, matchedAt, matchedAt, candidate.order_id);
          if (depId) usedDepositIds.add(depId);
          if (txId) usedTxIds.add(txId);
          status.lastMatchedOrderId = candidate.order_id;
          activeOrderIds.delete(candidate.order_id);
          settled += 1;
        } catch (error) {
          markCandidates([candidate.order_id], 'error', stateValue, `自动开通失败：${cleanText(error?.message || error, 350)}`);
        }
      }
      const checkedAt = nowIso();
      db.prepare("UPDATE usdt_order_payments SET last_checked_at=?,updated_at=? WHERE match_status IN ('awaiting','confirming','ambiguous','error')").run(checkedAt, checkedAt);
      status.lastSuccessAt = checkedAt;
      return { ok: true, checkedOrders: orders.length, deposits: deposits.length, settled, ambiguous, ...status };
    } catch (error) {
      status.lastError = cleanText(error?.message || error, 500);
      throw error;
    } finally {
      checking = false;
    }
  }

  function stopPoller() {
    if (pollTimer) clearInterval(pollTimer);
    if (startupTimer) clearTimeout(startupTimer);
    pollTimer = null;
    startupTimer = null;
  }
  function startPoller() {
    stopPoller();
    ensureRuntimeTables();
    const config = okxConfig();
    pollTimer = setInterval(() => {
      void runAutoSettlement().catch((error) => logger.warn?.('GPTWork OKX settlement check failed:', error.message));
    }, config.pollSeconds * 1000);
    pollTimer.unref?.();
    startupTimer = setTimeout(() => void runAutoSettlement().catch(() => {}), 1000);
    startupTimer.unref?.();
  }
  function attachSettlement(handler) {
    ensureRuntimeTables();
    settleOrderById = typeof handler === 'function' ? handler : null;
    startPoller();
  }
  function close() { stopPoller(); }

  function adminOkxPublic() {
    const config = okxConfig();
    return {
      enabled: config.enabled,
      configured: config.configured,
      apiKeyHint: config.apiKeyHint,
      pollSeconds: config.pollSeconds,
      orderTtlMinutes: config.orderTtlMinutes,
      allowInternalTransfers: config.allowInternalTransfers,
      baseUrl: config.baseUrl,
      ...status,
    };
  }
  function adminZpayPublic() {
    const config = zpayConfig();
    return {
      enabled: config.enabled, configured: config.configured, pidHint: config.pidHint,
      alipayCid: config.alipayCid, wechatCid: config.wechatCid, submitUrl: config.submitUrl, ...zpayStatus,
    };
  }

  async function handleAdmin(req, res, url) {
    if (!url.pathname.startsWith('/admin/api/payments')) return false;
    try {
      ensureRuntimeTables();
      if (url.pathname === '/admin/api/payments' && req.method === 'GET') {
        return json(res, 200, { ok: true, paymentMethods: list(false), okx: adminOkxPublic(), zpay: adminZpayPublic(), usdtPlanPrices: planPriceMap() }), true;
      }
      if (url.pathname === '/admin/api/payments/zpay' && req.method === 'PUT') {
        const input = await readJson(req, 128 * 1024);
        if (input.clearCredentials === true) {
          setSetting('zpay_pid', '');
          setSecureSetting('zpay_key', '');
          setSetting('zpay_enabled', '0');
        } else {
          if (input.pid !== undefined) {
            const pid = cleanText(input.pid, 128);
            if (pid && !/^[A-Za-z0-9]+$/.test(pid)) throw Object.assign(new Error('ZPAY 商户 ID 格式无效'), { status: 400, code: 'INVALID_ZPAY_PID' });
            setSetting('zpay_pid', pid);
          }
          if (input.key !== undefined && String(input.key)) setSecureSetting('zpay_key', String(input.key).slice(0, 512));
          if (input.enabled !== undefined) setSetting('zpay_enabled', input.enabled ? '1' : '0');
        }
        if (input.alipayCid !== undefined) setSetting('zpay_alipay_cid', cleanChannelIds(input.alipayCid));
        if (input.wechatCid !== undefined) setSetting('zpay_wechat_cid', cleanChannelIds(input.wechatCid));
        zpayStatus.lastError = '';
        return json(res, 200, { ok: true, zpay: adminZpayPublic() }), true;
      }
      if (url.pathname === '/admin/api/payments/zpay/test' && req.method === 'POST') {
        try {
          const result = await zpayClient().queryBalance();
          zpayStatus.lastTestAt = nowIso();
          zpayStatus.lastError = '';
          return json(res, 200, { ok: true, connected: true, balance: String(result.balance ?? ''), zpay: adminZpayPublic() }), true;
        } catch (error) {
          zpayStatus.lastTestAt = nowIso();
          zpayStatus.lastError = cleanText(error?.message || error, 500);
          throw error;
        }
      }
      const match = url.pathname.match(/^\/admin\/api\/payments\/(wechat|alipay|usdt)$/);
      if (match && req.method === 'PUT') {
        const code = match[1];
        const input = await readJson(req, 128 * 1024);
        const current = method(code);
        if (!current) throw Object.assign(new Error('支付方式不存在'), { status: 404, code: 'PAYMENT_METHOD_NOT_FOUND' });
        const payUrl = input.payUrl === undefined ? current.pay_url : normalizeHttpsUrl(input.payUrl);
        if (payUrl === null) throw Object.assign(new Error('支付链接必须为空或 HTTPS 地址'), { status: 400, code: 'INVALID_PAYMENT_URL' });
        const enabled = input.enabled === undefined ? current.enabled : (input.enabled ? 1 : 0);
        const instructions = input.instructions === undefined ? current.instructions : cleanText(input.instructions, 1000);
        db.prepare('UPDATE payment_methods SET enabled=?,pay_url=?,instructions=?,updated_at=? WHERE code=?')
          .run(enabled, payUrl, instructions, nowIso(), code);
        if (code !== 'usdt' && input.provider !== undefined) {
          if (!['manual', 'zpay'].includes(String(input.provider))) throw Object.assign(new Error('支付提供方仅支持 manual 或 zpay'), { status: 400, code: 'INVALID_PAYMENT_PROVIDER' });
          setSetting(`payment_provider_${code}`, String(input.provider));
        }
        if (code === 'usdt') {
          const crypto = input.crypto || {};
          const asset = cleanText(crypto.asset || current.crypto_asset || 'USDT', 24).toUpperCase() || 'USDT';
          if (asset !== 'USDT') throw Object.assign(new Error('当前仅支持 USDT 收款'), { status: 400, code: 'UNSUPPORTED_CRYPTO_ASSET' });
          db.prepare(`UPDATE payment_method_details SET crypto_asset=?,crypto_network=?,crypto_address=?,crypto_memo=?,updated_at=? WHERE code='usdt'`)
            .run(asset, cleanText(crypto.network ?? current.crypto_network, 80), cleanText(crypto.address ?? current.crypto_address, 256),
              cleanText(crypto.memo ?? current.crypto_memo, 160), nowIso());
        }
        return json(res, 200, { ok: true, paymentMethod: publicMethod(method(code)) }), true;
      }
      const qrMatch = url.pathname.match(/^\/admin\/api\/payments\/(wechat|alipay|usdt)\/qr$/);
      if (qrMatch && req.method === 'POST') {
        const code = qrMatch[1];
        const input = await readJson(req);
        const image = decodeDataUrl(input.dataUrl);
        db.prepare('UPDATE payment_method_details SET qr_mime=?,qr_blob=?,updated_at=? WHERE code=?')
          .run(image.mime, image.blob, nowIso(), code);
        const current = method(code);
        if (!current.pay_url && code !== 'usdt') {
          db.prepare('UPDATE payment_methods SET pay_url=?,updated_at=? WHERE code=?')
            .run(`${publicOrigin}/site/api/payment-qr/${code}`, nowIso(), code);
        }
        return json(res, 200, { ok: true, paymentMethod: publicMethod(method(code)) }), true;
      }
      if (qrMatch && req.method === 'DELETE') {
        const code = qrMatch[1];
        const qrUrl = `${publicOrigin}/site/api/payment-qr/${code}`;
        db.prepare("UPDATE payment_method_details SET qr_mime='',qr_blob=NULL,updated_at=? WHERE code=?").run(nowIso(), code);
        db.prepare("UPDATE payment_methods SET pay_url=CASE WHEN pay_url=? THEN '' ELSE pay_url END,updated_at=? WHERE code=?")
          .run(qrUrl, nowIso(), code);
        return json(res, 200, { ok: true, paymentMethod: publicMethod(method(code)) }), true;
      }
      if (url.pathname === '/admin/api/payments/usdt/prices' && req.method === 'PUT') {
        const input = await readJson(req, 128 * 1024);
        const prices = input.prices && typeof input.prices === 'object' ? input.prices : {};
        const plans = new Set(db.prepare('SELECT code FROM membership_plans').all().map((row) => row.code));
        db.exec('BEGIN IMMEDIATE');
        try {
          const upsert = db.prepare(`INSERT INTO payment_plan_prices(plan_code,payment_code,amount_micros,updated_at) VALUES(?,'usdt',?,?)
            ON CONFLICT(plan_code,payment_code) DO UPDATE SET amount_micros=excluded.amount_micros,updated_at=excluded.updated_at`);
          for (const [planCode, raw] of Object.entries(prices)) {
            if (!plans.has(planCode)) continue;
            if (String(raw ?? '').trim() === '') {
              db.prepare("DELETE FROM payment_plan_prices WHERE plan_code=? AND payment_code='usdt'").run(planCode);
              continue;
            }
            const micros = parseUsdtMicros(raw);
            if (!micros) throw Object.assign(new Error(`${planCode} 的 USDT 价格格式无效，最多 6 位小数`), { status: 400, code: 'INVALID_USDT_PRICE' });
            upsert.run(planCode, micros, nowIso());
          }
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        return json(res, 200, { ok: true, usdtPlanPrices: planPriceMap() }), true;
      }
      if (url.pathname === '/admin/api/payments/usdt/okx' && req.method === 'PUT') {
        const input = await readJson(req, 128 * 1024);
        if (input.clearCredentials === true) {
          setSecureSetting('okx_api_key', '');
          setSecureSetting('okx_secret_key', '');
          setSecureSetting('okx_passphrase', '');
        } else {
          if (input.apiKey !== undefined && String(input.apiKey).trim()) setSecureSetting('okx_api_key', cleanText(input.apiKey, 256));
          if (input.secretKey !== undefined && String(input.secretKey)) setSecureSetting('okx_secret_key', String(input.secretKey).slice(0, 512));
          if (input.passphrase !== undefined && String(input.passphrase)) setSecureSetting('okx_passphrase', String(input.passphrase).slice(0, 256));
        }
        if (input.enabled !== undefined) setSetting('okx_auto_settlement_enabled', input.enabled ? '1' : '0');
        if (input.pollSeconds !== undefined) setSetting('okx_poll_seconds', clampInt(input.pollSeconds, 10, 300, okxConfig().pollSeconds));
        if (input.orderTtlMinutes !== undefined) setSetting('usdt_order_ttl_minutes', clampInt(input.orderTtlMinutes, 30, 720, okxConfig().orderTtlMinutes));
        if (input.allowInternalTransfers !== undefined) setSetting('okx_allow_internal_transfers', input.allowInternalTransfers ? '1' : '0');
        startPoller();
        return json(res, 200, { ok: true, okx: adminOkxPublic() }), true;
      }
      if (url.pathname === '/admin/api/payments/usdt/okx/test' && req.method === 'POST') {
        const deposits = await createClient().getDepositHistory({ ccy: 'USDT', limit: 1 });
        status.lastCheckAt = nowIso();
        status.lastSuccessAt = status.lastCheckAt;
        status.lastError = '';
        return json(res, 200, { ok: true, connected: true, sampleCount: deposits.length, okx: adminOkxPublic() }), true;
      }
      if (url.pathname === '/admin/api/payments/usdt/okx/check' && req.method === 'POST') {
        const result = await runAutoSettlement({ force: true });
        return json(res, 200, result), true;
      }
      return false;
    } catch (error) {
      status.lastError = cleanText(error?.message || error, 500);
      replyFailure(res, error);
      return true;
    }
  }

  async function handleSite(req, res, url) {
    const checkoutMatch = url.pathname.match(/^\/site\/api\/zpay\/checkout\/(\d+)$/);
    if (checkoutMatch && req.method === 'GET') {
      try {
        const params = zpayCheckoutParams(Number(checkoutMatch[1]));
        const nonce = randomBytes(18).toString('base64url');
        const fields = Object.entries(params).map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`).join('');
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在前往 ZPAY</title></head><body><main><p>正在前往 ZPAY 安全收银台…</p><form id="zpay" method="post" action="${ZPAY_SUBMIT_URL}">${fields}<button type="submit">继续支付</button></form></main><script nonce="${nonce}">document.getElementById('zpay').submit();</script></body></html>`;
        const payload = Buffer.from(html, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; form-action https:; base-uri 'none'; frame-ancestors 'self'`,
          'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN', 'x-content-type-options': 'nosniff',
        });
        res.end(payload);
      } catch (error) { writePlain(res, error.status || 500, error.status ? error.message : 'ZPAY checkout failed'); }
      return true;
    }
    if (url.pathname === '/site/api/zpay/notify' && req.method === 'GET') {
      try {
        await settleZpayCallback(url);
        writePlain(res, 200, 'success');
      } catch (error) {
        logger.warn?.('GPTWork ZPAY notify rejected:', error.code || '', error.message);
        writePlain(res, error.status || 500, 'fail');
      }
      return true;
    }
    if (url.pathname === '/site/api/zpay/return' && req.method === 'GET') {
      let result = 'pending';
      try { await settleZpayCallback(url); result = 'success'; }
      catch (error) { logger.warn?.('GPTWork ZPAY return not settled:', error.code || '', error.message); }
      res.writeHead(302, { location: `${publicOrigin}/account?zpay=${result}`, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    if (url.pathname === '/site/api/payments' && req.method === 'GET') {
      return json(res, 200, { ok: true, paymentMethods: list(true) }), true;
    }
    const qrMatch = url.pathname.match(/^\/site\/api\/payment-qr\/(wechat|alipay|usdt)$/);
    if (qrMatch && ['GET', 'HEAD'].includes(req.method || '')) {
      const row = method(qrMatch[1], true);
      if (!row?.qr_blob || !row?.qr_mime) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end('Payment QR not found'), true;
      }
      const payload = Buffer.from(row.qr_blob);
      res.writeHead(200, {
        'content-type': row.qr_mime,
        'content-length': payload.length,
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
      });
      if (req.method === 'HEAD') res.end(); else res.end(payload);
      return true;
    }
    return false;
  }

  return {
    handleAdmin,
    handleSite,
    list,
    usdtQuote,
    attachUsdtOrder,
    orderPaymentDetails,
    prepareOrder,
    zpayOrderDetails,
    usdtOrderTtlMs,
    runAutoSettlement,
    attachSettlement,
    close,
    parseUsdtMicros,
    formatUsdtMicros,
  };
}
