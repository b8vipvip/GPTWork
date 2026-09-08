import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function bearer(req) {
  const value = String(req.headers?.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function normalizeHttpsUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function parseBenefits(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function planSnapshot(row, plan) {
  let parsed = null;
  try { parsed = JSON.parse(row.plan_snapshot_json || '{}'); } catch {}
  if (parsed && typeof parsed === 'object' && parsed.code && parsed.name) {
    return {
      code: String(parsed.code),
      name: String(parsed.name),
      priceCents: Number(parsed.priceCents || 0),
      durationDays: Number(parsed.durationDays || 0),
      maxDevices: Number(parsed.maxDevices || 0),
      maxWindows: Number(parsed.maxWindows || 0),
      benefits: Array.isArray(parsed.benefits) ? parsed.benefits.map((item) => String(item)).slice(0, 20) : [],
    };
  }
  return {
    code: String(plan?.code || row.plan_code || ''),
    name: String(plan?.name || row.plan_code || ''),
    priceCents: Number(plan?.price_cents || row.amount_cents || 0),
    durationDays: Number(plan?.duration_days || 0),
    maxDevices: Number(plan?.max_devices || 0),
    maxWindows: Number(plan?.max_windows || 0),
    benefits: parseBenefits(plan?.benefits_json),
  };
}

export function createAccountOrdersApi({ db, json, paymentSystem = null }) {
  function sessionFromRequest(req) {
    const token = bearer(req);
    if (!token) return null;
    const row = db.prepare(`SELECT s.id,s.user_id,s.expires_at,u.status AS user_status
      FROM user_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL`).get(sha256(token));
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      db.prepare('UPDATE user_sessions SET revoked_at=? WHERE id=?').run(new Date().toISOString(), row.id);
      return null;
    }
    if (row.user_status === 'disabled') return null;
    return row;
  }

  function paymentDetails(row) {
    if (!paymentSystem) return null;
    try {
      return row.payment_method === 'usdt'
        ? paymentSystem.orderPaymentDetails?.(row.id) || null
        : paymentSystem.zpayOrderDetails?.(row.id) || null;
    } catch {
      return null;
    }
  }

  function orderPublic(row) {
    const plan = db.prepare('SELECT * FROM membership_plans WHERE code=?').get(row.plan_code);
    return {
      id: row.id,
      planCode: row.plan_code,
      paymentMethod: row.payment_method,
      amountCents: row.amount_cents,
      status: row.status,
      payUrl: normalizeHttpsUrl(row.pay_url),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      paidAt: row.paid_at,
      membershipId: row.membership_id,
      planSnapshot: planSnapshot(row, plan),
      payment: paymentDetails(row),
    };
  }

  async function handleApi(req, res, url, cors = {}) {
    if (url.pathname !== '/api/v1/account/orders' || req.method !== 'GET') return false;
    const session = sessionFromRequest(req);
    if (!session) {
      json(res, 401, { ok: false, error: { code: 'AUTH_REQUIRED', message: '登录已失效，请重新登录 / Sign in again' } }, cors);
      return true;
    }

    const requestedLimit = Number(url.searchParams.get('limit') || 20);
    const limit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 20;
    const now = new Date().toISOString();
    // Keep list reconciliation aligned with the existing per-order API. USDT has its
    // own settlement window and is intentionally not expired by this generic pass.
    db.prepare(`UPDATE membership_orders SET status='expired'
      WHERE user_id=? AND status='pending' AND payment_method<>'usdt' AND expires_at<=?`).run(session.user_id, now);
    db.prepare('UPDATE user_sessions SET last_seen_at=? WHERE id=?').run(now, session.id);

    const rows = db.prepare(`SELECT * FROM membership_orders
      WHERE user_id=? ORDER BY id DESC LIMIT ?`).all(session.user_id, limit);
    json(res, 200, { ok: true, orders: rows.map(orderPublic), limit }, cors);
    return true;
  }

  return { handleApi };
}
