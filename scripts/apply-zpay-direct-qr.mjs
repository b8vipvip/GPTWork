import { readFile, writeFile, rm } from 'node:fs/promises';

async function load(path) { return readFile(path, 'utf8'); }
async function save(path, content) { await writeFile(path, content, 'utf8'); }
function once(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, got ${count}`);
  return source.replace(before, after);
}
function regexOnce(source, pattern, replacement, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`${label}: expected 1 match, got ${matches.length}`);
  return source.replace(pattern, replacement);
}

// 1) ZPAY client: add direct API-payment (/mapi.php) support and normalize QR URLs.
{
  const path = 'license-server/zpay-client.mjs';
  let s = await load(path);
  s = once(s,
    "export const ZPAY_SUBMIT_URL = `${ZPAY_ORIGIN}/submit.php`;\nexport const ZPAY_API_URL = `${ZPAY_ORIGIN}/api.php`;",
    "export const ZPAY_SUBMIT_URL = `${ZPAY_ORIGIN}/submit.php`;\nexport const ZPAY_MAPI_URL = `${ZPAY_ORIGIN}/mapi.php`;\nexport const ZPAY_API_URL = `${ZPAY_ORIGIN}/api.php`;",
    'zpay mapi constant');
  s = once(s,
    "function compactText(value, max = 240) {\n  return String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, max);\n}\n",
    "function compactText(value, max = 240) {\n  return String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, max);\n}\nfunction normalizeHttps(value) {\n  try {\n    const url = new URL(String(value || '').trim());\n    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return '';\n    url.hash = '';\n    return url.toString();\n  } catch { return ''; }\n}\n",
    'zpay https normalizer');
  s = once(s,
    "  return {\n    probeCredentials,\n    queryBalance: probeCredentials,\n    queryOrder(outTradeNo) { return request({ act: 'order', pid: merchantId, key: merchantKey, out_trade_no: String(outTradeNo) }); },\n  };",
    `  async function createPayment(params = {}) {\n    const form = new FormData();\n    for (const [name, value] of Object.entries(params || {})) {\n      if (value === null || value === undefined || String(value) === '') continue;\n      form.set(String(name), String(value));\n    }\n    form.set('pid', merchantId);\n\n    let response;\n    try {\n      response = await fetchImpl(ZPAY_MAPI_URL, { method: 'POST', body: form, headers: { accept: 'application/json' } });\n    } catch (cause) {\n      const detail = compactText(cause?.message || cause || 'network error');\n      throw createApiError(\`ZPAY 支付接口网络连接失败：\${detail}\`, 'ZPAY_NETWORK_ERROR');\n    }\n    const text = await response.text().catch(() => '');\n    const body = parsePossiblyWrappedJson(text);\n    if (!response.ok) {\n      const detail = compactText(body?.msg || body?.message || text);\n      throw createApiError(detail ? \`ZPAY 支付接口 HTTP \${response.status}：\${detail}\` : \`ZPAY 支付接口 HTTP \${response.status}\`);\n    }\n    if (!body || typeof body !== 'object' || Array.isArray(body)) {\n      const preview = compactText(text);\n      throw createApiError(preview ? \`ZPAY 支付接口返回了非 JSON 响应：\${preview}\` : 'ZPAY 支付接口返回了空响应', 'ZPAY_INVALID_RESPONSE');\n    }\n    if (Number(body.code) !== 1) {\n      const authFailure = authFailureMessage(body);\n      if (authFailure) throw createApiError(\`ZPAY 商户凭据校验失败：\${authFailure}\`, 'ZPAY_AUTH_ERROR');\n      throw createApiError(compactText(body?.msg) || \`ZPAY 支付接口返回错误 code=\${String(body.code ?? '')}\`);\n    }\n    return {\n      code: 1,\n      msg: compactText(body.msg || ''),\n      orderId: compactText(body.O_id || '', 128),\n      tradeNo: compactText(body.trade_no || '', 128),\n      payUrl: normalizeHttps(body.payurl),\n      payUrl2: normalizeHttps(body.payurl2),\n      qrCode: compactText(body.qrcode || '', 2048),\n      qrImageUrl: normalizeHttps(body.img),\n    };\n  }\n\n  return {\n    probeCredentials,\n    createPayment,\n    queryBalance: probeCredentials,\n    queryOrder(outTradeNo) { return request({ act: 'order', pid: merchantId, key: merchantKey, out_trade_no: String(outTradeNo) }); },\n  };`,
    'zpay createPayment');
  await save(path, s);
}

// 2) Payment system: persist direct ZPAY checkout/QR data and fall back to submit.php only if MAPI is unavailable.
{
  const path = 'license-server/payment-system.mjs';
  let s = await load(path);
  s = once(s,
    "        zpay_trade_no TEXT NOT NULL DEFAULT '',\n        status TEXT NOT NULL DEFAULT 'awaiting' CHECK(status IN ('awaiting','settled','error')),",
    "        zpay_trade_no TEXT NOT NULL DEFAULT '',\n        zpay_order_no TEXT NOT NULL DEFAULT '',\n        checkout_url TEXT NOT NULL DEFAULT '',\n        qr_image_url TEXT NOT NULL DEFAULT '',\n        qr_payload TEXT NOT NULL DEFAULT '',\n        status TEXT NOT NULL DEFAULT 'awaiting' CHECK(status IN ('awaiting','settled','error')),",
    'zpay payment columns');
  s = once(s,
    "      CREATE UNIQUE INDEX IF NOT EXISTS idx_zpay_trade_no ON zpay_order_payments(zpay_trade_no) WHERE zpay_trade_no<>'';\n    `);\n    runtimeReady = true;",
    "      CREATE UNIQUE INDEX IF NOT EXISTS idx_zpay_trade_no ON zpay_order_payments(zpay_trade_no) WHERE zpay_trade_no<>'';\n    `);\n    const zpayColumns = new Set(db.prepare('PRAGMA table_info(zpay_order_payments)').all().map((row) => row.name));\n    for (const [column, definition] of [\n      ['zpay_order_no', \"zpay_order_no TEXT NOT NULL DEFAULT ''\"],\n      ['checkout_url', \"checkout_url TEXT NOT NULL DEFAULT ''\"],\n      ['qr_image_url', \"qr_image_url TEXT NOT NULL DEFAULT ''\"],\n      ['qr_payload', \"qr_payload TEXT NOT NULL DEFAULT ''\"],\n    ]) {\n      if (!zpayColumns.has(column)) db.exec(`ALTER TABLE zpay_order_payments ADD COLUMN ${definition}`);\n    }\n    runtimeReady = true;",
    'zpay payment migration');
  s = once(s,
    "      provider: 'zpay', merchantTradeNo: row.merchant_trade_no, tradeNo: row.zpay_trade_no || '',\n      channel: row.channel, status: row.status, paidAt: row.paid_at, lastError: row.last_error || '',",
    "      provider: 'zpay', merchantTradeNo: row.merchant_trade_no, tradeNo: row.zpay_trade_no || '',\n      orderNo: row.zpay_order_no || '', channel: row.channel, status: row.status, paidAt: row.paid_at,\n      payUrl: normalizeHttpsUrl(row.checkout_url) || '', qrImageUrl: normalizeHttpsUrl(row.qr_image_url) || '',\n      qrPayload: cleanText(row.qr_payload, 2048), lastError: row.last_error || '',",
    'zpay order public details');
  s = once(s, "  function prepareOrder(order, context = {}) {", "  async function prepareOrder(order, context = {}) {", 'prepareOrder async');
  s = once(s,
    "    const payUrl = `${publicOrigin}/site/api/zpay/checkout/${order.id}`;\n    db.prepare('UPDATE membership_orders SET pay_url=? WHERE id=?').run(payUrl, order.id);\n    return db.prepare('SELECT * FROM membership_orders WHERE id=?').get(order.id);",
    `    const detail = db.prepare('SELECT * FROM zpay_order_payments WHERE order_id=?').get(order.id);\n    let directPayUrl = normalizeHttpsUrl(detail?.checkout_url) || '';\n    if (!directPayUrl && !normalizeHttpsUrl(detail?.qr_image_url) && !cleanText(detail?.qr_payload, 2048)) {\n      try {\n        const config = zpayConfig();\n        let snapshot = {};\n        try { snapshot = JSON.parse(order.plan_snapshot_json || '{}'); } catch {}\n        const params = {\n          pid: config.pid,\n          type: detail.channel,\n          out_trade_no: detail.merchant_trade_no,\n          notify_url: \`\${publicOrigin}/site/api/zpay/notify\`,\n          name: \`GPTWork \${cleanText(snapshot.name || order.plan_code || '会员', 72)} 会员服务\`.slice(0, 100),\n          money: zpayMoneyFromCents(detail.amount_cents),\n          clientip: cleanText(detail.client_ip || context.clientIp || '127.0.0.1', 64),\n          param: \`order-\${order.id}\`,\n        };\n        const cid = detail.channel === 'alipay' ? config.alipayCid : config.wechatCid;\n        if (cid) params.cid = cid;\n        params.sign = zpaySign(params, config.key);\n        params.sign_type = 'MD5';\n        const created = await createZpayClient({ pid: config.pid, key: config.key, fetchImpl }).createPayment(params);\n        directPayUrl = created.payUrl || created.payUrl2 || '';\n        db.prepare(\`UPDATE zpay_order_payments SET zpay_order_no=?,checkout_url=?,qr_image_url=?,qr_payload=?,last_error='',updated_at=? WHERE order_id=?\`)\n          .run(cleanText(created.orderId, 128), directPayUrl, normalizeHttpsUrl(created.qrImageUrl) || '', cleanText(created.qrCode, 2048), nowIso(), order.id);\n      } catch (error) {\n        const message = cleanText(error?.message || error, 500);\n        db.prepare('UPDATE zpay_order_payments SET last_error=?,updated_at=? WHERE order_id=?').run(message, nowIso(), order.id);\n        logger?.warn?.('ZPAY direct QR creation failed; using checkout handoff fallback', { orderId: order.id, error: message });\n      }\n    }\n    const payUrl = directPayUrl || \`\${publicOrigin}/site/api/zpay/checkout/\${order.id}\`;\n    db.prepare('UPDATE membership_orders SET pay_url=? WHERE id=?').run(payUrl, order.id);\n    return db.prepare('SELECT * FROM membership_orders WHERE id=?').get(order.id);`,
    'zpay direct order creation');
  await save(path, s);
}

// 3) Extension account API must expose the same provider-specific payment metadata as the website API.
{
  const path = 'license-server/account-system.mjs';
  let s = await load(path);
  s = once(s,
    "      membershipId: row.membership_id,\n      planSnapshot: normalizePlanSnapshot(row.plan_snapshot_json, db.prepare('SELECT * FROM membership_plans WHERE code=?').get(row.plan_code)),",
    "      membershipId: row.membership_id,\n      planSnapshot: normalizePlanSnapshot(row.plan_snapshot_json, db.prepare('SELECT * FROM membership_plans WHERE code=?').get(row.plan_code)),\n      payment: paymentSystem ? (row.payment_method === 'usdt' ? paymentSystem.orderPaymentDetails(row.id) : paymentSystem.zpayOrderDetails(row.id)) : null,",
    'extension payment metadata');
  await save(path, s);
}

// 4) Website account center: prefer direct QR image and reopen pending orders by real order ID, not checkout URL shape.
{
  const path = 'license-server/public/account-commerce.js';
  let s = await load(path);
  s = once(s,
    "  const payUrl = String(order.payUrl || ''); const qrUrl = String(method?.qrUrl || '');\n  if (qrUrl.startsWith('https://')) {\n    const img = document.createElement('img'); img.src = qrUrl; img.alt = `${paymentLabel(method.code)}支付二维码`;",
    "  const payUrl = String(order.payUrl || ''); const qrUrl = String(order.payment?.qrImageUrl || method?.qrUrl || '');\n  if (qrUrl.startsWith('https://')) {\n    const img = document.createElement('img'); img.src = qrUrl; img.alt = `${paymentLabel(method.code)}支付二维码`;",
    'site direct qr preference');
  s = once(s,
    "    setStyles(img, { display: 'block', width: '280px', maxWidth: '80%', margin: '28px auto', borderRadius: '14px' }); modal.frameWrap.append(img);",
    "    setStyles(img, { display: 'block', width: '280px', maxWidth: '80%', margin: '28px auto 14px', borderRadius: '14px' }); modal.frameWrap.append(img);\n    const hint = document.createElement('div'); hint.textContent = `请使用${paymentLabel(method.code)}扫码完成支付`; setStyles(hint, { textAlign: 'center', color: '#475569', fontSize: '13px', fontWeight: '700', paddingBottom: '20px' }); modal.frameWrap.append(hint);",
    'site qr hint');
  s = regexOnce(s,
    /  const pending = event\.target\.closest\?\.\('#orderList a'\);[\s\S]*?\n  }\n}, true\);/,
    `  const pending = event.target.closest?.('#orderList a');\n  if (pending && /继续/.test(pending.textContent || '')) {\n    event.preventDefault(); event.stopImmediatePropagation();\n    const row = pending.closest('.list-row');\n    const match = String(row?.querySelector('.list-main b')?.textContent || '').match(/^#(\\d+)/);\n    if (match) void api(\`/site/api/account/orders/\${match[1]}\`).then((data) => {\n      const order = data.order; const method = (state.config?.paymentMethods || []).find((item) => item.code === order.paymentMethod) || { code: order.paymentMethod };\n      const plan = (state.config?.plans || []).find((item) => item.code === order.planCode);\n      openPaymentModal(order, method, plan);\n    }).catch(() => window.open(pending.href, '_blank', 'noopener,noreferrer'));\n  }\n}, true);`,
    'site pending order reopen');
  await save(path, s);
}

// 5) Extension account center: prefer provider QR metadata so ZPAY does not depend on iframe/X-Frame-Options.
{
  const path = 'extension/account-commerce.js';
  let s = await load(path);
  s = once(s,
    "  if (order.payUrl) {\n    const iframe = document.createElement('iframe'); iframe.src = order.payUrl; iframe.title = '安全支付收银台'; iframe.setAttribute('allow', 'payment *');\n    styles(iframe, { width: '100%', height: '100%', minHeight: '430px', border: '0', background: '#fff' }); frameWrap.append(iframe);\n    const fallback = document.createElement('button'); fallback.textContent = '支付二维码未显示？在新窗口打开'; fallback.addEventListener('click', () => chrome.tabs.create({ url: order.payUrl })); foot.append(fallback);\n  } else frameWrap.textContent = '当前支付方式没有可用支付页面。';",
    "  const qrUrl = String(order.payment?.qrImageUrl || '');\n  if (qrUrl.startsWith('https://')) {\n    const img = document.createElement('img'); img.src = qrUrl; img.alt = `${paymentLabel(method.code)}支付二维码`;\n    styles(img, { display: 'block', width: '280px', maxWidth: '80%', margin: '28px auto 14px', borderRadius: '14px' }); frameWrap.append(img);\n    const hint = document.createElement('div'); hint.textContent = `请使用${paymentLabel(method.code)}扫码完成支付`; styles(hint, { textAlign: 'center', color: '#475569', fontSize: '13px', fontWeight: '700', paddingBottom: '20px' }); frameWrap.append(hint);\n  } else if (order.payUrl) {\n    const iframe = document.createElement('iframe'); iframe.src = order.payUrl; iframe.title = '安全支付收银台'; iframe.setAttribute('allow', 'payment *');\n    styles(iframe, { width: '100%', height: '100%', minHeight: '430px', border: '0', background: '#fff' }); frameWrap.append(iframe);\n    const fallback = document.createElement('button'); fallback.textContent = '支付二维码未显示？在新窗口打开'; fallback.addEventListener('click', () => chrome.tabs.create({ url: order.payUrl })); foot.append(fallback);\n  } else frameWrap.textContent = '当前支付方式没有可用支付页面。';",
    'extension direct qr preference');
  await save(path, s);
}

// 6) Public account CSP needs to permit HTTPS QR images returned by the configured payment provider.
{
  const path = 'license-server/server.mjs';
  let s = await load(path);
  s = once(s, "img-src 'self' data:; frame-src 'self' https:;", "img-src 'self' data: https:; frame-src 'self' https:;", 'public qr CSP');
  await save(path, s);
}

// 7) Regression tests: API payment response normalization + website/extension direct-QR parity.
{
  const path = 'license-server/test/zpay-client.test.mjs';
  let s = await load(path);
  s += `\n\ntest('ZPAY MAPI creates a direct checkout and exposes QR metadata', async () => {\n  let requestedUrl = ''; let requestedInit = null;\n  const client = createZpayClient({\n    pid: '10001', key: 'merchant-secret',\n    fetchImpl: async (url, init) => {\n      requestedUrl = String(url); requestedInit = init;\n      return jsonResponse({ code: 1, msg: 'success', O_id: '10009', trade_no: 'T20260907', payurl: 'https://pay.example/checkout', payurl2: 'https://pay.example/alt', qrcode: 'weixin://wxpay/example', img: 'https://pay.example/qr.png' });\n    },\n  });\n  const result = await client.createPayment({ type: 'wxpay', out_trade_no: '123', money: '19.00', sign: 'abc', sign_type: 'MD5' });\n  assert.equal(requestedUrl, 'https://zpayz.cn/mapi.php');\n  assert.equal(requestedInit.method, 'POST');\n  assert.equal(requestedInit.body.get('pid'), '10001');\n  assert.equal(requestedInit.body.get('type'), 'wxpay');\n  assert.equal(result.orderId, '10009');\n  assert.equal(result.payUrl, 'https://pay.example/checkout');\n  assert.equal(result.qrCode, 'weixin://wxpay/example');\n  assert.equal(result.qrImageUrl, 'https://pay.example/qr.png');\n});\n`;
  await save(path, s);
}
{
  const path = 'license-server/test/account-commerce-parity.test.mjs';
  let s = await load(path);
  s = once(s,
    "    assert.match(source, /GET_ORDER|site\\/api\\/account\\/orders/);",
    "    assert.match(source, /GET_ORDER|site\\/api\\/account\\/orders/);\n    assert.match(source, /qrImageUrl/);\n    assert.match(source, /扫码完成支付/);",
    'commerce direct qr parity');
  s = once(s,
    "  assert.match(server, /frame-src 'self' https:/);",
    "  assert.match(server, /frame-src 'self' https:/);\n  assert.match(server, /img-src 'self' data: https:/);",
    'commerce direct qr CSP');
  await save(path, s);
}

// Remove one-shot patch infrastructure so it never lands in the product diff.
await rm('scripts/apply-zpay-direct-qr.mjs', { force: true });
await rm('.github/workflows/zpay-direct-qr-patch.yml', { force: true });
console.log('ZPAY direct QR patch applied');
