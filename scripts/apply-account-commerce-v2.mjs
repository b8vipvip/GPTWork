import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

function read(path) { return readFileSync(path, 'utf8'); }
function write(path, content) { writeFileSync(path, content, 'utf8'); }
function once(path, before, after, label) {
  const source = read(path);
  const n = source.split(before).length - 1;
  if (n !== 1) throw new Error(`${path}: ${label} expected 1 match, got ${n}`);
  write(path, source.replace(before, after));
}
function regex(path, pattern, after, label) {
  const source = read(path);
  if (!pattern.test(source)) throw new Error(`${path}: missing ${label}`);
  write(path, source.replace(pattern, after));
}

// Fix production ZPAY redirect CSP and allow secure modal embedding.
once('license-server/payment-system.mjs',
  "form-action https://zpayz.cn; base-uri 'none'; frame-ancestors 'none'",
  "form-action https:; base-uri 'none'; frame-ancestors 'self'", 'ZPAY form-action');
once('license-server/payment-system.mjs',
  "'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',",
  "'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN', 'x-content-type-options': 'nosniff',", 'ZPAY frame header');

once('license-server/server.mjs',
  "connect-src 'self'; img-src 'self' data:; frame-ancestors 'none';",
  "connect-src 'self'; img-src 'self' data:; frame-src 'self' https:; frame-ancestors 'none';", 'site frame-src');
once('license-server/server.mjs',
  "if (url.pathname === '/site.js') return staticFile(res, join(PUBLIC,'site.js'));\n",
  "if (url.pathname === '/site.js') return staticFile(res, join(PUBLIC,'site.js'));\n    if (url.pathname === '/account-commerce.js') return staticFile(res, join(PUBLIC,'account-commerce.js'));\n", 'account-commerce route');

// Account pricing schema + public config + paid order amount.
once('license-server/account-system.mjs',
  "import { sendSmtpMail } from './smtp-client.mjs';\n",
  "import { sendSmtpMail } from './smtp-client.mjs';\nimport { normalizePlanPricing } from './plan-pricing.mjs';\n", 'pricing import');
once('license-server/account-system.mjs',
  "ensureColumn('membership_orders', 'plan_snapshot_json', \"plan_snapshot_json TEXT NOT NULL DEFAULT '{}'\");\n",
  "ensureColumn('membership_orders', 'plan_snapshot_json', \"plan_snapshot_json TEXT NOT NULL DEFAULT '{}'\");\n  ensureColumn('membership_plans', 'original_price_cents', 'original_price_cents INTEGER NOT NULL DEFAULT 0 CHECK(original_price_cents >= 0)');\n  ensureColumn('membership_plans', 'promo_price_cents', 'promo_price_cents INTEGER CHECK(promo_price_cents IS NULL OR promo_price_cents >= 0)');\n  ensureColumn('membership_plans', 'promo_ends_at', 'promo_ends_at TEXT');\n  db.prepare('UPDATE membership_plans SET original_price_cents=price_cents WHERE original_price_cents=0 AND price_cents>0').run();\n", 'pricing migration');
once('license-server/account-system.mjs',
  "        priceCents: row.price_cents,\n        durationDays: row.duration_days,\n",
  "        ...normalizePlanPricing(row),\n        durationDays: row.duration_days,\n", 'public pricing');
once('license-server/account-system.mjs',
  "          return { code: row.code, name: row.name, priceCents: row.price_cents, durationDays: row.duration_days,\n            limits: { devices: row.max_devices, windows: row.max_windows }, benefits, enabled: Boolean(row.enabled), sortOrder: row.sort_order };\n",
  "          return { code: row.code, name: row.name, ...normalizePlanPricing(row), durationDays: row.duration_days,\n            limits: { devices: row.max_devices, windows: row.max_windows }, benefits, enabled: Boolean(row.enabled), sortOrder: row.sort_order };\n", 'admin pricing output');
regex('license-server/account-system.mjs',
/        const name = String\(input\.name \|\| plan\.name\)\.slice\(0, 120\);\n        const priceCents = clampInt\(input\.priceCents, 0, 100000000, plan\.price_cents\);\n        const durationDays = clampInt\(input\.durationDays, 1, 3650, plan\.duration_days\);\n        const maxDevices = clampInt\(input\.maxDevices, 1, 1000, plan\.max_devices\);\n        const maxWindows = clampInt\(input\.maxWindows, 1, 1000, plan\.max_windows\);\n        const benefits = Array\.isArray\(input\.benefits\) \? input\.benefits\.map\(\(item\) => String\(item\)\.slice\(0, 160\)\)\.slice\(0, 20\) : JSON\.parse\(plan\.benefits_json \|\| '\[\]'\);\n        const enabled = input\.enabled === undefined \? plan\.enabled : \(input\.enabled \? 1 : 0\);\n        db\.prepare\(`UPDATE membership_plans SET name=\?,price_cents=\?,duration_days=\?,max_devices=\?,max_windows=\?,benefits_json=\?,enabled=\?,updated_at=\? WHERE code=\?`\)\n          \.run\(name, priceCents, durationDays, maxDevices, maxWindows, JSON\.stringify\(benefits\), enabled, nowIso\(\), plan\.code\);\n        audit\('admin_plan_updated', null, \{ planCode: plan\.code, priceCents, durationDays, maxDevices, maxWindows, enabled: Boolean\(enabled\) \}\);/,
`        const name = String(input.name || plan.name).slice(0, 120);
        const currentPricing = normalizePlanPricing(plan);
        const originalPriceCents = clampInt(input.originalPriceCents ?? input.priceCents, 0, 100000000, currentPricing.originalPriceCents);
        let promoPriceCents = input.promoPriceCents;
        promoPriceCents = promoPriceCents === null || promoPriceCents === undefined || promoPriceCents === '' ? null : Number(promoPriceCents);
        if (promoPriceCents !== null && (!Number.isInteger(promoPriceCents) || promoPriceCents < 0 || promoPriceCents > 100000000)) fail(400, 'INVALID_PROMO_PRICE', '促销价必须是有效金额');
        const promoEndsAt = input.promoEndsAt ? parseIso(input.promoEndsAt) : null;
        if (promoPriceCents !== null) {
          if (promoPriceCents >= originalPriceCents) fail(400, 'INVALID_PROMO_PRICE', '促销价必须低于原价');
          if (!promoEndsAt || Date.parse(promoEndsAt) <= Date.now()) fail(400, 'INVALID_PROMO_END', '促销结束时间必须晚于当前时间');
        }
        const durationDays = clampInt(input.durationDays, 1, 3650, plan.duration_days);
        const maxDevices = clampInt(input.maxDevices, 1, 1000, plan.max_devices);
        const maxWindows = clampInt(input.maxWindows, 1, 1000, plan.max_windows);
        const benefits = Array.isArray(input.benefits) ? input.benefits.map((item) => String(item).slice(0, 160)).slice(0, 20) : JSON.parse(plan.benefits_json || '[]');
        const enabled = input.enabled === undefined ? plan.enabled : (input.enabled ? 1 : 0);
        db.prepare(\`UPDATE membership_plans SET name=?,price_cents=?,original_price_cents=?,promo_price_cents=?,promo_ends_at=?,duration_days=?,max_devices=?,max_windows=?,benefits_json=?,enabled=?,updated_at=? WHERE code=?\`)
          .run(name, originalPriceCents, originalPriceCents, promoPriceCents, promoPriceCents === null ? null : promoEndsAt, durationDays, maxDevices, maxWindows, JSON.stringify(benefits), enabled, nowIso(), plan.code);
        audit('admin_plan_updated', null, { planCode: plan.code, originalPriceCents, promoPriceCents, promoEndsAt, durationDays, maxDevices, maxWindows, enabled: Boolean(enabled) });`, 'admin pricing update');

once('license-server/account-system.mjs',
  "        const payUrl = normalizeHttpsUrl(method.pay_url) || '';\n        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();\n        const frozenTerms = planSnapshotFromRow(plan);\n        const result = db.prepare(`INSERT INTO membership_orders(user_id,plan_code,payment_method,amount_cents,status,pay_url,created_at,expires_at,plan_snapshot_json)\n          VALUES(?,?,?,?, 'pending',?,?,?,?)`).run(session.user_id, plan.code, method.code, plan.price_cents, payUrl, nowIso(), expiresAt, JSON.stringify(frozenTerms));\n",
  "        const payUrl = normalizeHttpsUrl(method.pay_url) || '';\n        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();\n        const pricing = normalizePlanPricing(plan);\n        const frozenTerms = planSnapshotFromRow({ ...plan, price_cents: pricing.priceCents });\n        const result = db.prepare(`INSERT INTO membership_orders(user_id,plan_code,payment_method,amount_cents,status,pay_url,created_at,expires_at,plan_snapshot_json)\n          VALUES(?,?,?,?, 'pending',?,?,?,?)`).run(session.user_id, plan.code, method.code, pricing.priceCents, payUrl, nowIso(), expiresAt, JSON.stringify(frozenTerms));\n", 'extension order price');
once('license-server/account-system.mjs',
  "        audit('order_created', session.user_id, { orderId: order.id, planCode: plan.code, paymentMethod: method.code, amountCents: plan.price_cents });\n",
  "        audit('order_created', session.user_id, { orderId: order.id, planCode: plan.code, paymentMethod: method.code, amountCents: pricing.priceCents });\n", 'extension order audit');

// Website API same price contract.
once('license-server/site-account.mjs',
  "import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';\n",
  "import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';\nimport { normalizePlanPricing } from './plan-pricing.mjs';\n", 'site pricing import');
once('license-server/site-account.mjs',
  "      return { code: row.code, name: row.name, priceCents: row.price_cents, durationDays: row.duration_days,\n        limits: { devices: row.max_devices }, benefits };\n",
  "      return { code: row.code, name: row.name, ...normalizePlanPricing(row), durationDays: row.duration_days,\n        limits: { devices: row.max_devices }, benefits };\n", 'site pricing output');
once('license-server/site-account.mjs',
  "        const snapshot = { code: plan.code, name: plan.name, priceCents: plan.price_cents, durationDays: plan.duration_days,\n          maxDevices: plan.max_devices, maxWindows: plan.max_windows, benefits };\n",
  "        const pricing = normalizePlanPricing(plan);\n        const snapshot = { code: plan.code, name: plan.name, priceCents: pricing.priceCents, originalPriceCents: pricing.originalPriceCents, promoPriceCents: pricing.promoPriceCents, promoEndsAt: pricing.promoEndsAt, durationDays: plan.duration_days,\n          maxDevices: plan.max_devices, maxWindows: plan.max_windows, benefits };\n", 'site order snapshot');
once('license-server/site-account.mjs',
  "          VALUES(?,?,?,?, 'pending',?,?,?,?)`).run(session.user_id, plan.code, method.code, plan.price_cents,\n",
  "          VALUES(?,?,?,?, 'pending',?,?,?,?)`).run(session.user_id, plan.code, method.code, pricing.priceCents,\n", 'site order price');

// Admin plan editor.
once('license-server/public/admin.js',
  "  const price = makeField('价格（元）', (plan.priceCents / 100).toFixed(2), 0); price.step = '0.01';\n  const days = makeField('有效天数', plan.durationDays, 1);\n",
  "  const originalPrice = makeField('原价（元）', ((plan.originalPriceCents ?? plan.priceCents) / 100).toFixed(2), 0); originalPrice.step = '0.01';\n  const promoPrice = makeField('促销价（元，可选）', plan.promoPriceCents === null || plan.promoPriceCents === undefined ? '' : (plan.promoPriceCents / 100).toFixed(2), 0); promoPrice.step = '0.01';\n  const promoEndLabel = document.createElement('label'); promoEndLabel.textContent = '促销结束时间（可选）';\n  const promoEnd = document.createElement('input'); promoEnd.type = 'datetime-local'; promoEnd.value = localDateInput(plan.promoEndsAt); promoEndLabel.append(promoEnd); grid.append(promoEndLabel);\n  const days = makeField('有效天数', plan.durationDays, 1);\n", 'admin price fields');
once('license-server/public/admin.js',
  "      const priceCents = Math.round(Number(price.value) * 100);\n      await api(`/admin/api/account/plans/${encodeURIComponent(plan.code)}`, {\n        method: 'PUT',\n        body: JSON.stringify({\n          name: name.value.trim(), priceCents, durationDays: Number(days.value), maxDevices: Number(devices.value), maxWindows: plan.limits.windows,\n",
  "      const originalPriceCents = Math.round(Number(originalPrice.value) * 100);\n      const promoPriceCents = promoPrice.value.trim() === '' ? null : Math.round(Number(promoPrice.value) * 100);\n      const promoEndsAt = promoEnd.value ? new Date(promoEnd.value).toISOString() : null;\n      if (!Number.isInteger(originalPriceCents) || originalPriceCents < 0) throw new Error('原价格式无效');\n      if (promoPriceCents !== null && (!Number.isInteger(promoPriceCents) || promoPriceCents < 0 || promoPriceCents >= originalPriceCents)) throw new Error('促销价必须低于原价');\n      if (promoPriceCents !== null && (!promoEndsAt || Date.parse(promoEndsAt) <= Date.now())) throw new Error('促销结束时间必须晚于当前时间');\n      await api(`/admin/api/account/plans/${encodeURIComponent(plan.code)}`, {\n        method: 'PUT',\n        body: JSON.stringify({\n          name: name.value.trim(), priceCents: originalPriceCents, originalPriceCents, promoPriceCents, promoEndsAt, durationDays: Number(days.value), maxDevices: Number(devices.value), maxWindows: plan.limits.windows,\n", 'admin price save');

// Load new commerce UI in both account centers.
once('license-server/public/account.html', '<script src="/site.js"></script>\n', '<script src="/site.js"></script>\n<script type="module" src="/account-commerce.js"></script>\n', 'site commerce script');
once('extension/account.html', '<script type="module" src="account.js"></script>\n', '<script type="module" src="account.js"></script>\n<script type="module" src="account-commerce.js"></script>\n', 'extension commerce script');
once('license-server/package.json', 'node --check zpay-client.mjs', 'node --check zpay-client.mjs && node --check plan-pricing.mjs', 'pricing check');
once('license-server/package.json', 'node --check public/site.js', 'node --check public/site.js && node --check public/account-commerce.js', 'commerce check');

for (const helper of ['scripts/apply-account-commerce-v2.mjs', '.github/workflows/account-commerce-v2-patch.yml']) {
  if (existsSync(helper)) unlinkSync(helper);
}
