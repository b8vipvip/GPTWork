import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { sendSmtpMail } from './smtp-client.mjs';

const scryptAsync = promisify(scrypt);

class AccountError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details && typeof details === 'object' ? details : null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PLANS = [
  {
    code: 'monthly', name: '月卡 / Monthly', priceCents: 1900, durationDays: 30,
    maxDevices: 3, maxWindows: 3, sortOrder: 10,
    benefits: ['30 天会员有效期', '最多 3 台设备', '最多 3 个同时窗口', '完整 GPTWork 功能'],
  },
  {
    code: 'quarterly', name: '季卡 / Quarterly', priceCents: 4900, durationDays: 90,
    maxDevices: 5, maxWindows: 5, sortOrder: 20,
    benefits: ['90 天会员有效期', '最多 5 台设备', '最多 5 个同时窗口', '完整 GPTWork 功能'],
  },
  {
    code: 'yearly', name: '年卡 / Yearly', priceCents: 16900, durationDays: 365,
    maxDevices: 10, maxWindows: 10, sortOrder: 30,
    benefits: ['365 天会员有效期', '最多 10 台设备', '最多 10 个同时窗口', '完整 GPTWork 功能'],
  },
];

function nowIso() { return new Date().toISOString(); }
function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function isEmail(value) {
  const email = normalizeEmail(value);
  return email.length >= 5 && email.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,189}$/.test(email);
}
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
function validId(value, max = 180) {
  return typeof value === 'string' && value.length >= 8 && value.length <= max && /^[A-Za-z0-9._:-]+$/.test(value);
}
function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function parseIso(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
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
function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}
function extensionIdFromOrigin(value) {
  const match = String(value || '').match(/^chrome-extension:\/\/([a-z]{32})$/i);
  return match ? match[1].toLowerCase() : null;
}
function passwordValid(value) {
  return typeof value === 'string' && value.length >= 10 && value.length <= 128;
}
async function encodePassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$v1$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
async function verifyPassword(password, encoded) {
  try {
    const [algo, version, nText, rText, pText, saltText, hashText] = String(encoded || '').split('$');
    if (algo !== 'scrypt' || version !== 'v1') return false;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    const derived = await scryptAsync(String(password || ''), salt, expected.length, {
      N: Number(nText), r: Number(rText), p: Number(pText), maxmem: 64 * 1024 * 1024,
    });
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch { return false; }
}

export function createAccountSystem({
  db,
  env,
  secret,
  publicOrigin,
  allowedExtensionIds,
  windowTtlSeconds,
  json,
  bodyJson,
  clientIp,
  paymentSystem = null,
}) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled')),
    email_verified_at TEXT,
    email_verification_exempt INTEGER NOT NULL DEFAULT 0 CHECK(email_verification_exempt IN (0,1)),
    free_expires_at TEXT,
    max_devices_override INTEGER CHECK(max_devices_override IS NULL OR max_devices_override >= 1),
    max_windows_override INTEGER CHECK(max_windows_override IS NULL OR max_windows_override >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS user_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE(user_id, device_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    browser_instance_id TEXT NOT NULL,
    extension_id TEXT NOT NULL,
    extension_version TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    UNIQUE(user_id, device_id, browser_instance_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS user_window_leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
    window_key TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE(session_id, window_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS email_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed_at TEXT,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS membership_plans (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
    duration_days INTEGER NOT NULL CHECK(duration_days >= 1),
    max_devices INTEGER NOT NULL CHECK(max_devices >= 1),
    max_windows INTEGER NOT NULL CHECK(max_windows >= 1),
    benefits_json TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_code TEXT NOT NULL REFERENCES membership_plans(code),
    starts_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
    source TEXT NOT NULL DEFAULT 'admin',
    order_id INTEGER,
    plan_snapshot_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS payment_methods (
    code TEXT PRIMARY KEY CHECK(code IN ('wechat','alipay')),
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    pay_url TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS membership_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_code TEXT NOT NULL REFERENCES membership_plans(code),
    payment_method TEXT NOT NULL REFERENCES payment_methods(code),
    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','cancelled','expired')),
    pay_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    paid_at TEXT,
    membership_id INTEGER,
    plan_snapshot_json TEXT NOT NULL DEFAULT '{}'
  ) STRICT;
  CREATE TABLE IF NOT EXISTS secure_settings (
    key TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS account_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    user_id INTEGER,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash);
  CREATE INDEX IF NOT EXISTS idx_user_windows_seen ON user_window_leases(last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id,purpose);
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id,expires_at);
  CREATE INDEX IF NOT EXISTS idx_orders_user ON membership_orders(user_id,created_at);
  `);

  function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
  ensureColumn('users', 'email_verification_exempt', 'email_verification_exempt INTEGER NOT NULL DEFAULT 0 CHECK(email_verification_exempt IN (0,1))');
  ensureColumn('memberships', 'plan_snapshot_json', "plan_snapshot_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn('membership_orders', 'plan_snapshot_json', "plan_snapshot_json TEXT NOT NULL DEFAULT '{}'");

  const insertPlan = db.prepare(`INSERT OR IGNORE INTO membership_plans
    (code,name,price_cents,duration_days,max_devices,max_windows,benefits_json,enabled,sort_order,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  for (const plan of DEFAULT_PLANS) {
    insertPlan.run(plan.code, plan.name, plan.priceCents, plan.durationDays, plan.maxDevices, plan.maxWindows,
      JSON.stringify(plan.benefits), 1, plan.sortOrder, nowIso());
  }
  const insertPayment = db.prepare(`INSERT OR IGNORE INTO payment_methods(code,name,enabled,pay_url,instructions,updated_at) VALUES(?,?,?,?,?,?)`);
  insertPayment.run('wechat', '微信支付 / WeChat Pay', 0, '', '', nowIso());
  insertPayment.run('alipay', '支付宝 / Alipay', 0, '', '', nowIso());

  function planSnapshotFromRow(plan) {
    let benefits = [];
    try { benefits = Array.isArray(plan?.benefits) ? plan.benefits : JSON.parse(plan?.benefits_json || '[]'); } catch {}
    return {
      code: String(plan?.code || plan?.plan_code || ''),
      name: String(plan?.name || ''),
      priceCents: clampInt(plan?.price_cents ?? plan?.priceCents, 0, 100000000, 0),
      durationDays: clampInt(plan?.duration_days ?? plan?.durationDays, 1, 3650, 1),
      maxDevices: clampInt(plan?.max_devices ?? plan?.maxDevices, 1, 1000, 1),
      maxWindows: clampInt(plan?.max_windows ?? plan?.maxWindows, 1, 1000, 1),
      benefits: benefits.map((item) => String(item).slice(0, 160)).slice(0, 20),
    };
  }
  function normalizePlanSnapshot(value, fallback) {
    let parsed = value;
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed || '{}'); } catch { parsed = null; } }
    if (!parsed || typeof parsed !== 'object' || !parsed.code || !parsed.name) return planSnapshotFromRow(fallback);
    return planSnapshotFromRow({
      code: parsed.code, name: parsed.name, priceCents: parsed.priceCents, durationDays: parsed.durationDays,
      maxDevices: parsed.maxDevices, maxWindows: parsed.maxWindows, benefits: parsed.benefits,
    });
  }
  function freezeLegacyPlanSnapshots() {
    const memberships = db.prepare(`SELECT m.id,m.plan_code,m.plan_snapshot_json,p.* FROM memberships m JOIN membership_plans p ON p.code=m.plan_code`).all();
    const saveMembership = db.prepare('UPDATE memberships SET plan_snapshot_json=? WHERE id=?');
    for (const row of memberships) {
      let parsed = null;
      try { parsed = JSON.parse(row.plan_snapshot_json || '{}'); } catch {}
      if (!parsed?.code) saveMembership.run(JSON.stringify(planSnapshotFromRow(row)), row.id);
    }
    const orders = db.prepare(`SELECT o.id,o.plan_code,o.plan_snapshot_json,p.* FROM membership_orders o JOIN membership_plans p ON p.code=o.plan_code`).all();
    const saveOrder = db.prepare('UPDATE membership_orders SET plan_snapshot_json=? WHERE id=?');
    for (const row of orders) {
      let parsed = null;
      try { parsed = JSON.parse(row.plan_snapshot_json || '{}'); } catch {}
      if (!parsed?.code) saveOrder.run(JSON.stringify(planSnapshotFromRow(row)), row.id);
    }
  }
  freezeLegacyPlanSnapshots();

  const CONFIG_KEY = createHmac('sha256', secret).update('gptlock-account-secure-settings:v1').digest();
  const CODE_KEY = createHmac('sha256', secret).update('gptlock-account-email-code:v1').digest();
  const rate = new Map();
  const LOGIN_MAX = Math.max(3, Number(env.GPTLOCK_ACCOUNT_LOGIN_MAX_ATTEMPTS || 10));
  const LOGIN_WINDOW_MS = Math.max(60_000, Number(env.GPTLOCK_ACCOUNT_LOGIN_WINDOW_MS || 15 * 60 * 1000));
  const LOGIN_IP_MAX = Math.max(LOGIN_MAX, Number(env.GPTLOCK_ACCOUNT_LOGIN_IP_MAX_ATTEMPTS || 30));
  const EMAIL_MAX = Math.max(2, Number(env.GPTLOCK_ACCOUNT_EMAIL_MAX_ATTEMPTS || 5));
  const EMAIL_WINDOW_MS = Math.max(60_000, Number(env.GPTLOCK_ACCOUNT_EMAIL_WINDOW_MS || 10 * 60 * 1000));
  const EMAIL_IP_MAX = Math.max(EMAIL_MAX, Number(env.GPTLOCK_ACCOUNT_EMAIL_IP_MAX_ATTEMPTS || 15));
  const EMAIL_CODE_TTL_MINUTES = Math.max(5, Number(env.GPTLOCK_ACCOUNT_EMAIL_CODE_TTL_MINUTES || 15));
  const EMAIL_CODE_MAX_ATTEMPTS = Math.max(3, Number(env.GPTLOCK_ACCOUNT_EMAIL_CODE_MAX_ATTEMPTS || 6));
  const TEST_EMAIL_MODE = env.GPTLOCK_ACCOUNT_EMAIL_TEST_MODE === '1';
  const testOutbox = TEST_EMAIL_MODE ? [] : null;
  const dummyPasswordHashPromise = encodePassword(randomBytes(24).toString('base64url'));

  function getSetting(key, fallback = '') {
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    return row ? row.value : fallback;
  }
  function setSetting(key, value) {
    db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(key, String(value), nowIso());
  }
  function getIntSetting(key, fallback, min, max) {
    return clampInt(getSetting(key, String(fallback)), min, max, fallback);
  }
  function encryptSetting(value, keyName) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', CONFIG_KEY, iv);
    cipher.setAAD(Buffer.from(`gptlock-account-setting:v1:${keyName}`));
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
  }
  function decryptSetting(value, keyName) {
    if (!value) return '';
    try {
      const [version, ivText, tagText, dataText] = String(value).split('.');
      if (version !== 'v1') return '';
      const decipher = createDecipheriv('aes-256-gcm', CONFIG_KEY, Buffer.from(ivText, 'base64url'));
      decipher.setAAD(Buffer.from(`gptlock-account-setting:v1:${keyName}`));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
    } catch { return ''; }
  }
  function setSecureSetting(key, value) {
    if (!value) {
      db.prepare('DELETE FROM secure_settings WHERE key=?').run(key);
      return;
    }
    db.prepare(`INSERT INTO secure_settings(key,ciphertext,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`)
      .run(key, encryptSetting(value, key), nowIso());
  }
  function getSecureSetting(key) {
    const row = db.prepare('SELECT ciphertext FROM secure_settings WHERE key=?').get(key);
    return row ? decryptSetting(row.ciphertext, key) : '';
  }

  function audit(event, userId = null, detail = {}) {
    const sanitized = {};
    for (const [key, value] of Object.entries(detail || {})) {
      if (/password|token|code|secret/i.test(key)) continue;
      sanitized[key] = value;
    }
    db.prepare('INSERT INTO account_audit_log(event,user_id,detail,created_at) VALUES(?,?,?,?)')
      .run(event, userId, JSON.stringify(sanitized).slice(0, 4000), nowIso());
  }

  function replyError(res, status, code, message, headers = {}, details = null) {
    const error = { code, message };
    if (details && typeof details === 'object') error.details = details;
    json(res, status, { ok: false, error }, headers);
  }
  function fail(status, code, message, details = null) { throw new AccountError(status, code, message, details); }

  function extensionAllowed(req, extensionId) {
    const claimed = String(extensionId || '').trim().toLowerCase();
    if (!allowedExtensionIds.has(claimed)) return false;
    const origin = String(req.headers.origin || '');
    if (!origin) return true;
    const originId = extensionIdFromOrigin(origin);
    return Boolean(originId && originId === claimed && allowedExtensionIds.has(originId));
  }

  function rateKey(scope, req, subject = '') {
    const suffix = subject ? `:${sha256(subject).slice(0, 24)}` : '';
    return `${scope}:${clientIp(req)}${suffix}`;
  }
  function rateCheck(scope, req, max, windowMs, subject = '') {
    const key = rateKey(scope, req, subject);
    const now = Date.now();
    const row = rate.get(key);
    if (!row || row.resetAt <= now) {
      if (row) rate.delete(key);
      return { key, count: 0, resetAt: now + windowMs };
    }
    if (row.count >= max) fail(429, 'RATE_LIMITED', '操作过于频繁，请稍后再试 / Too many attempts');
    return { key, ...row };
  }
  function rateFailure(scope, req, max, windowMs, subject = '') {
    const row = rateCheck(scope, req, max, windowMs, subject);
    rate.set(row.key, { count: row.count + 1, resetAt: row.resetAt });
    if (rate.size > 8192) {
      const now = Date.now();
      for (const [key, value] of rate) if (value.resetAt <= now) rate.delete(key);
    }
  }
  function rateClear(scope, req, subject = '') { rate.delete(rateKey(scope, req, subject)); }

  function freeConfig() {
    return {
      days: getIntSetting('account_free_days', 7, 0, 3650),
      maxDevices: getIntSetting('account_free_max_devices', 1, 1, 1000),
      maxWindows: getIntSetting('account_free_max_windows', 1, 1, 1000),
    };
  }
  function sessionDays() { return getIntSetting('account_session_days', 30, 1, 365); }
  function emailVerificationRequired() { return getSetting('account_email_verification_required', '1') !== '0'; }
  function emailAccessSatisfied(user) { return Boolean(user?.email_verified_at || user?.email_verification_exempt); }

  function purgeWindowLeases() {
    const cutoff = new Date(Date.now() - Math.max(60, windowTtlSeconds) * 1000).toISOString();
    db.prepare('DELETE FROM user_window_leases WHERE last_seen_at < ?').run(cutoff);
  }
  function userByEmail(email) { return db.prepare('SELECT * FROM users WHERE email=?').get(normalizeEmail(email)); }
  function userById(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(Number(id)); }
  function hydrateMembership(row) {
    if (!row) return null;
    const fallback = planSnapshotFromRow({
      code: row.plan_code, name: row.current_plan_name, price_cents: row.current_price_cents, duration_days: row.current_duration_days,
      max_devices: row.current_max_devices, max_windows: row.current_max_windows, benefits_json: row.current_benefits_json,
    });
    const terms = normalizePlanSnapshot(row.plan_snapshot_json, fallback);
    return { ...row, name: terms.name, price_cents: terms.priceCents, duration_days: terms.durationDays,
      max_devices: terms.maxDevices, max_windows: terms.maxWindows, benefits_json: JSON.stringify(terms.benefits) };
  }
  const MEMBERSHIP_SELECT = `SELECT m.*,p.name AS current_plan_name,p.price_cents AS current_price_cents,
      p.duration_days AS current_duration_days,p.max_devices AS current_max_devices,p.max_windows AS current_max_windows,
      p.benefits_json AS current_benefits_json FROM memberships m JOIN membership_plans p ON p.code=m.plan_code`;
  function currentMembership(userId) {
    const now = nowIso();
    return hydrateMembership(db.prepare(`${MEMBERSHIP_SELECT}
      WHERE m.user_id=? AND m.status='active' AND m.starts_at<=? AND m.expires_at>?
      ORDER BY m.expires_at DESC LIMIT 1`).get(userId, now, now));
  }
  function nextMembership(userId) {
    const now = nowIso();
    return hydrateMembership(db.prepare(`${MEMBERSHIP_SELECT}
      WHERE m.user_id=? AND m.status='active' AND m.starts_at>?
      ORDER BY m.starts_at ASC LIMIT 1`).get(userId, now));
  }
  function entitlementFor(user) {
    const free = freeConfig();
    const membership = user ? currentMembership(user.id) : null;
    let active = false;
    let source = 'none';
    let expiresAt = user?.free_expires_at || null;
    let maxDevices = free.maxDevices;
    let maxWindows = free.maxWindows;
    if (user && user.status === 'active' && emailAccessSatisfied(user)) {
      if (membership) {
        active = true;
        source = 'membership';
        expiresAt = membership.expires_at;
        maxDevices = membership.max_devices;
        maxWindows = membership.max_windows;
      } else if (user.free_expires_at && Date.parse(user.free_expires_at) > Date.now()) {
        active = true;
        source = 'free';
        expiresAt = user.free_expires_at;
      }
    }
    if (user?.max_devices_override !== null && user?.max_devices_override !== undefined) maxDevices = user.max_devices_override;
    if (user?.max_windows_override !== null && user?.max_windows_override !== undefined) maxWindows = user.max_windows_override;
    purgeWindowLeases();
    const usageDevices = user ? db.prepare('SELECT COUNT(*) AS count FROM user_devices WHERE user_id=?').get(user.id).count : 0;
    const usageWindows = user ? db.prepare(`SELECT COUNT(*) AS count FROM user_window_leases wl
      JOIN user_sessions s ON s.id=wl.session_id WHERE s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>?`).get(user.id, nowIso()).count : 0;
    return {
      active,
      source,
      expiresAt,
      limits: { devices: maxDevices, windows: maxWindows },
      usage: { devices: usageDevices, windows: usageWindows },
    };
  }
  function membershipPublic(row) {
    if (!row) return null;
    let benefits = [];
    try { benefits = JSON.parse(row.benefits_json || '[]'); } catch {}
    return {
      id: row.id,
      planCode: row.plan_code,
      name: row.name,
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      benefits,
      limits: { devices: row.max_devices, windows: row.max_windows },
    };
  }
  function accountSummary(user, session = null) {
    if (!user) return { authenticated: false };
    const membership = currentMembership(user.id);
    const next = nextMembership(user.id);
    return {
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        emailVerified: Boolean(user.email_verified_at),
        emailVerifiedAt: user.email_verified_at,
        emailVerificationExempt: Boolean(user.email_verification_exempt),
        freeExpiresAt: user.free_expires_at,
        createdAt: user.created_at,
      },
      membership: membershipPublic(membership),
      nextMembership: membershipPublic(next),
      entitlement: entitlementFor(user),
      session: session ? { expiresAt: session.expires_at, deviceId: session.device_id } : null,
    };
  }

  function sessionFromToken(token) {
    if (!token) return null;
    const row = db.prepare(`SELECT s.*,u.email,u.password_hash,u.status AS user_status,u.email_verified_at,u.email_verification_exempt,u.free_expires_at,
      u.max_devices_override,u.max_windows_override,u.created_at AS user_created_at,u.updated_at AS user_updated_at
      FROM user_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL`).get(sha256(token));
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      db.prepare('UPDATE user_sessions SET revoked_at=? WHERE id=?').run(nowIso(), row.id);
      return null;
    }
    row.user = {
      id: row.user_id,
      email: row.email,
      password_hash: row.password_hash,
      status: row.user_status,
      email_verified_at: row.email_verified_at,
      email_verification_exempt: row.email_verification_exempt,
      free_expires_at: row.free_expires_at,
      max_devices_override: row.max_devices_override,
      max_windows_override: row.max_windows_override,
      created_at: row.user_created_at,
      updated_at: row.user_updated_at,
    };
    return row;
  }
  function requireSession(req) {
    const session = sessionFromToken(bearer(req));
    if (!session) fail(401, 'AUTH_REQUIRED', '登录已失效，请重新登录 / Sign in again');
    return session;
  }

  function emailCodeHash(userId, purpose, code) {
    return createHmac('sha256', CODE_KEY).update(`${purpose}:${userId}:${code}`).digest('hex');
  }
  function createEmailToken(user, purpose) {
    const code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MINUTES * 60 * 1000).toISOString();
    db.prepare('UPDATE email_tokens SET consumed_at=? WHERE user_id=? AND purpose=? AND consumed_at IS NULL')
      .run(nowIso(), user.id, purpose);
    db.prepare('INSERT INTO email_tokens(user_id,purpose,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,0,?)')
      .run(user.id, purpose, emailCodeHash(user.id, purpose, code), expiresAt, nowIso());
    return { code, expiresAt };
  }
  function consumeEmailToken(user, purpose, code) {
    const row = db.prepare(`SELECT * FROM email_tokens WHERE user_id=? AND purpose=? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`)
      .get(user.id, purpose);
    if (!row || Date.parse(row.expires_at) <= Date.now()) fail(400, 'CODE_EXPIRED', '验证码已过期，请重新获取');
    if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) fail(429, 'CODE_LOCKED', '验证码尝试次数过多，请重新获取');
    const expected = emailCodeHash(user.id, purpose, String(code || '').trim());
    if (!safeEqual(expected, row.code_hash)) {
      db.prepare('UPDATE email_tokens SET attempts=attempts+1 WHERE id=?').run(row.id);
      fail(400, 'CODE_INVALID', '验证码错误');
    }
    db.prepare('UPDATE email_tokens SET consumed_at=? WHERE id=?').run(nowIso(), row.id);
    return true;
  }

  function smtpConfig() {
    return {
      host: getSetting('smtp_host', ''),
      port: getIntSetting('smtp_port', 465, 1, 65535),
      secure: getSetting('smtp_secure', '1') !== '0',
      username: getSetting('smtp_username', ''),
      password: getSecureSetting('smtp_password'),
      fromEmail: getSetting('smtp_from_email', ''),
      fromName: getSetting('smtp_from_name', 'GPTWork'),
    };
  }
  function smtpConfigured() {
    const smtp = smtpConfig();
    return Boolean(smtp.host && smtp.fromEmail && (!smtp.username || smtp.password));
  }
  async function deliverCode(user, purpose, code) {
    const subject = purpose === 'verify_email' ? 'GPTWork 邮箱验证' : 'GPTWork 找回密码';
    const action = purpose === 'verify_email' ? '完成邮箱验证' : '重置 GPTWork 密码';
    const text = `您好，\n\n您正在${action}。\n验证码：${code}\n\n验证码 ${EMAIL_CODE_TTL_MINUTES} 分钟内有效，请勿转发给任何人。\n如果不是您本人操作，请忽略本邮件。\n\nGPTWork`;
    if (TEST_EMAIL_MODE) {
      testOutbox.push({ to: user.email, purpose, subject, text, code, createdAt: nowIso() });
      return;
    }
    if (!smtpConfigured()) fail(503, 'EMAIL_NOT_CONFIGURED', '服务端尚未配置发信邮箱，请联系管理员');
    try {
      await sendSmtpMail(smtpConfig(), { to: user.email, subject, text });
    } catch (error) {
      audit('email_send_failed', user.id, { purpose, error: String(error?.message || error).slice(0, 240) });
      fail(502, 'EMAIL_SEND_FAILED', '验证码邮件发送失败，请稍后重试');
    }
  }
  async function issueCode(user, purpose) {
    const token = createEmailToken(user, purpose);
    await deliverCode(user, purpose, token.code);
    audit('email_code_sent', user.id, { purpose, expiresAt: token.expiresAt });
    return token.expiresAt;
  }

  function publicPlans() {
    return db.prepare('SELECT * FROM membership_plans WHERE enabled=1 ORDER BY sort_order,code').all().map((row) => {
      let benefits = [];
      try { benefits = JSON.parse(row.benefits_json || '[]'); } catch {}
      return {
        code: row.code,
        name: row.name,
        priceCents: row.price_cents,
        durationDays: row.duration_days,
        limits: { devices: row.max_devices, windows: row.max_windows },
        benefits,
      };
    });
  }
  function publicPaymentMethods() {
    return db.prepare('SELECT * FROM payment_methods WHERE enabled=1 ORDER BY code').all().map((row) => ({
      code: row.code,
      name: row.name,
      payUrl: normalizeHttpsUrl(row.pay_url) || '',
      instructions: row.instructions,
    }));
  }

  function securitySnapshot(userId, currentSession = null) {
    const now = nowIso();
    const devices = db.prepare(`SELECT d.*,COUNT(CASE WHEN s.revoked_at IS NULL AND s.expires_at>? THEN 1 END) AS active_sessions
      FROM user_devices d LEFT JOIN user_sessions s ON s.user_id=d.user_id AND s.device_id=d.device_id
      WHERE d.user_id=? GROUP BY d.id ORDER BY d.last_seen_at DESC,d.id DESC`).all(now, userId).map((row) => ({
        id: row.id,
        platform: row.platform || 'unknown',
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        activeSessions: Number(row.active_sessions || 0),
        current: Boolean(currentSession && row.device_id === currentSession.device_id),
      }));
    const sessions = db.prepare(`SELECT s.*,d.id AS device_record_id,d.platform AS device_platform
      FROM user_sessions s LEFT JOIN user_devices d ON d.user_id=s.user_id AND d.device_id=s.device_id
      WHERE s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? ORDER BY s.last_seen_at DESC,s.id DESC`).all(userId, now).map((row) => ({
        id: row.id,
        deviceRecordId: row.device_record_id || null,
        platform: row.device_platform || row.platform || 'unknown',
        extensionVersion: row.extension_version || '',
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        current: Boolean(currentSession && row.id === currentSession.id),
        currentDevice: Boolean(currentSession && row.device_id === currentSession.device_id),
      }));
    return { devices, sessions };
  }

  function revokeSessionsForDevice(userId, deviceId, revokedAt = nowIso()) {
    const sessionRows = db.prepare('SELECT id FROM user_sessions WHERE user_id=? AND device_id=? AND revoked_at IS NULL').all(userId, deviceId);
    for (const row of sessionRows) db.prepare('DELETE FROM user_window_leases WHERE session_id=?').run(row.id);
    db.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND device_id=? AND revoked_at IS NULL').run(revokedAt, userId, deviceId);
    return sessionRows.length;
  }

  function releaseDeviceRecord(userId, deviceRecordId, { currentSession = null, reason = 'self_service' } = {}) {
    const id = Number(deviceRecordId);
    if (!Number.isInteger(id) || id <= 0) fail(400, 'INVALID_DEVICE_RECORD', '设备记录无效');
    const device = db.prepare('SELECT * FROM user_devices WHERE id=? AND user_id=?').get(id, userId);
    if (!device) fail(404, 'DEVICE_NOT_FOUND', '设备不存在或已释放');
    if (currentSession && device.device_id === currentSession.device_id) {
      fail(409, 'CURRENT_DEVICE', '不能从当前会话释放当前设备；如需退出当前设备请使用退出登录');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      revokeSessionsForDevice(userId, device.device_id);
      db.prepare('DELETE FROM user_devices WHERE id=? AND user_id=?').run(id, userId);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    audit('device_released_by_user', userId, { deviceRecordId: id, platform: device.platform, reason });
    return device;
  }

  function ensureDevice(user, input) {
    const deviceId = String(input.deviceId || '');
    if (!validId(deviceId)) fail(400, 'INVALID_DEVICE', '设备标识无效');
    const existing = db.prepare('SELECT * FROM user_devices WHERE user_id=? AND device_id=?').get(user.id, deviceId);
    if (existing) {
      db.prepare('UPDATE user_devices SET last_seen_at=?,platform=? WHERE id=?')
        .run(nowIso(), String(input.platform || '').slice(0, 80), existing.id);
      return existing;
    }
    const entitlement = entitlementFor(user);
    const limit = Math.max(1, entitlement.limits.devices);
    let count = Number(db.prepare('SELECT COUNT(*) AS count FROM user_devices WHERE user_id=?').get(user.id).count || 0);
    if (count >= limit) {
      const requested = [...new Set((Array.isArray(input.replaceDeviceRecordIds) ? input.replaceDeviceRecordIds : [])
        .map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 128))];
      const requiredReleaseCount = Math.max(1, count - limit + 1);
      if (requested.length < requiredReleaseCount) {
        fail(409, 'DEVICE_LIMIT', `设备数量已达到上限 ${limit}，请选择至少 ${requiredReleaseCount} 台旧设备释放后登录`, {
          limit, requiredReleaseCount, devices: securitySnapshot(user.id).devices,
        });
      }
      const owned = requested.map((id) => db.prepare('SELECT * FROM user_devices WHERE id=? AND user_id=?').get(id, user.id));
      if (owned.some((row) => !row)) fail(400, 'INVALID_REPLACEMENT_DEVICE', '选择的旧设备无效，请刷新后重试');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of owned) {
          revokeSessionsForDevice(user.id, row.device_id);
          db.prepare('DELETE FROM user_devices WHERE id=? AND user_id=?').run(row.id, user.id);
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      audit('devices_replaced_on_login', user.id, { deviceRecordIds: owned.map((row) => row.id), releasedCount: owned.length });
      count = Number(db.prepare('SELECT COUNT(*) AS count FROM user_devices WHERE user_id=?').get(user.id).count || 0);
      if (count >= limit) {
        fail(409, 'DEVICE_LIMIT', `仍有 ${count} 台已绑定设备，当前上限 ${limit}，请继续释放旧设备`, {
          limit, requiredReleaseCount: Math.max(1, count - limit + 1), devices: securitySnapshot(user.id).devices,
        });
      }
    }
    const result = db.prepare('INSERT INTO user_devices(user_id,device_id,platform,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)')
      .run(user.id, deviceId, String(input.platform || '').slice(0, 80), nowIso(), nowIso());
    audit('device_bound', user.id, { deviceId, platform: String(input.platform || '').slice(0, 80) });
    return { id: Number(result.lastInsertRowid), device_id: deviceId };
  }
  function issueSession(user, input) {
    ensureDevice(user, input);
    const browserInstanceId = String(input.browserInstanceId || '');
    if (!validId(browserInstanceId)) fail(400, 'INVALID_BROWSER_INSTANCE', '浏览器实例标识无效');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionDays() * DAY_MS).toISOString();
    const existing = db.prepare('SELECT * FROM user_sessions WHERE user_id=? AND device_id=? AND browser_instance_id=?')
      .get(user.id, input.deviceId, browserInstanceId);
    if (existing) {
      db.prepare(`UPDATE user_sessions SET token_hash=?,extension_id=?,extension_version=?,platform=?,last_seen_at=?,expires_at=?,revoked_at=NULL WHERE id=?`)
        .run(sha256(token), String(input.extensionId).slice(0, 80), String(input.extensionVersion || '').slice(0, 40),
          String(input.platform || '').slice(0, 80), nowIso(), expiresAt, existing.id);
      db.prepare('DELETE FROM user_window_leases WHERE session_id=?').run(existing.id);
    } else {
      db.prepare(`INSERT INTO user_sessions(user_id,token_hash,device_id,browser_instance_id,extension_id,extension_version,platform,created_at,last_seen_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(user.id, sha256(token), input.deviceId, browserInstanceId,
          String(input.extensionId).slice(0, 80), String(input.extensionVersion || '').slice(0, 40), String(input.platform || '').slice(0, 80),
          nowIso(), nowIso(), expiresAt);
    }
    db.prepare('UPDATE users SET last_login_at=?,updated_at=? WHERE id=?').run(nowIso(), nowIso(), user.id);
    const session = sessionFromToken(token);
    audit('login_succeeded', user.id, { deviceId: input.deviceId, extensionVersion: String(input.extensionVersion || '') });
    return { token, account: accountSummary(userById(user.id), session), heartbeatSeconds: 60 };
  }

  function grantMembership(userId, planCode, source = 'admin', orderId = null, frozenTerms = null) {
    const plan = db.prepare('SELECT * FROM membership_plans WHERE code=?').get(String(planCode || ''));
    if (!plan) fail(404, 'PLAN_NOT_FOUND', '会员套餐不存在');
    const terms = normalizePlanSnapshot(frozenTerms, plan);
    if (terms.code !== plan.code) fail(409, 'PLAN_SNAPSHOT_MISMATCH', '订单套餐快照与套餐不匹配');
    const latest = db.prepare(`SELECT expires_at FROM memberships WHERE user_id=? AND status='active' ORDER BY expires_at DESC LIMIT 1`).get(userId);
    const baseMs = Math.max(Date.now(), Date.parse(latest?.expires_at || '') || 0);
    const startsAt = new Date(baseMs).toISOString();
    const expiresAt = new Date(baseMs + terms.durationDays * DAY_MS).toISOString();
    const result = db.prepare(`INSERT INTO memberships(user_id,plan_code,starts_at,expires_at,status,source,order_id,plan_snapshot_json,created_at) VALUES(?,?,?,?, 'active',?,?,?,?)`)
      .run(userId, plan.code, startsAt, expiresAt, source, orderId, JSON.stringify(terms), nowIso());
    audit('membership_granted', userId, { membershipId: Number(result.lastInsertRowid), planCode: plan.code, startsAt, expiresAt, source });
    return hydrateMembership(db.prepare(`${MEMBERSHIP_SELECT} WHERE m.id=?`).get(Number(result.lastInsertRowid)));
  }

  function orderPublic(row) {
    if (!row) return null;
    return {
      id: row.id,
      planCode: row.plan_code,
      paymentMethod: row.payment_method,
      amountCents: row.amount_cents,
      status: row.status,
      payUrl: normalizeHttpsUrl(row.pay_url) || '',
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      paidAt: row.paid_at,
      membershipId: row.membership_id,
      planSnapshot: normalizePlanSnapshot(row.plan_snapshot_json, db.prepare('SELECT * FROM membership_plans WHERE code=?').get(row.plan_code)),
    };
  }
  function markOrderPaid(row, { allowExpiredPending = false } = {}) {
    if (!row) fail(404, 'ORDER_NOT_FOUND', '订单不存在');
    if (row.status === 'paid') return row;
    if (row.status !== 'pending') fail(409, 'ORDER_NOT_PENDING', '订单当前状态无法确认付款');
    if (!allowExpiredPending && Date.parse(row.expires_at) <= Date.now()) {
      db.prepare(`UPDATE membership_orders SET status='expired' WHERE id=? AND status='pending'`).run(row.id);
      fail(409, 'ORDER_EXPIRED', '订单已过期，请让用户重新创建订单');
    }
    const frozenTerms = normalizePlanSnapshot(row.plan_snapshot_json, db.prepare('SELECT * FROM membership_plans WHERE code=?').get(row.plan_code));
    const membership = grantMembership(row.user_id, row.plan_code, 'order', row.id, frozenTerms);
    db.prepare(`UPDATE membership_orders SET status='paid',paid_at=?,membership_id=? WHERE id=?`)
      .run(nowIso(), membership.id, row.id);
    audit('order_marked_paid', row.user_id, { orderId: row.id, membershipId: membership.id });
    return db.prepare('SELECT * FROM membership_orders WHERE id=?').get(row.id);
  }

  async function handleApi(req, res, url, cors = {}) {
    const path = url.pathname;
    const isAccountPath = path.startsWith('/api/v1/account/') || path.startsWith('/api/v1/auth/');
    if (!isAccountPath) return false;
    try {
      if (path === '/api/v1/account/config' && req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          accountRequired: true,
          emailVerificationRequired: emailVerificationRequired(),
          free: freeConfig(),
          plans: publicPlans(),
          paymentMethods: publicPaymentMethods(),
        }, cors), true;
      }

      if (path === '/api/v1/auth/register' && req.method === 'POST') {
        const input = await bodyJson(req);
        if (!extensionAllowed(req, input.extensionId)) fail(403, 'EXTENSION_NOT_ALLOWED', '只允许官方 GPTWork 扩展注册');
        const email = normalizeEmail(input.email);
        if (!isEmail(email) || !passwordValid(input.password)) fail(400, 'INVALID_REGISTRATION', '请输入有效邮箱，密码至少 10 位');
        rateCheck('register-ip', req, EMAIL_IP_MAX, EMAIL_WINDOW_MS);
        rateCheck('register', req, EMAIL_MAX, EMAIL_WINDOW_MS, email);
        const verificationRequired = emailVerificationRequired();
        let user = userByEmail(email);
        if (user && (emailAccessSatisfied(user) || user.status === 'disabled')) {
          fail(409, 'ACCOUNT_EXISTS', '该邮箱已注册，请直接登录或找回密码');
        }
        const passwordHash = await encodePassword(input.password);
        if (verificationRequired) {
          if (user) {
            db.prepare(`UPDATE users SET password_hash=?,status='pending',email_verification_exempt=0,updated_at=? WHERE id=?`)
              .run(passwordHash, nowIso(), user.id);
          } else {
            const result = db.prepare(`INSERT INTO users(email,password_hash,status,email_verification_exempt,created_at,updated_at) VALUES(?,?,'pending',0,?,?)`)
              .run(email, passwordHash, nowIso(), nowIso());
            user = userById(Number(result.lastInsertRowid));
          }
          rateFailure('register-ip', req, EMAIL_IP_MAX, EMAIL_WINDOW_MS);
          rateFailure('register', req, EMAIL_MAX, EMAIL_WINDOW_MS, email);
          const expiresAt = await issueCode(user, 'verify_email');
          audit('account_registered', user.id, { emailDomain: email.split('@')[1], verificationRequired: true, expiresAt });
          return json(res, 201, { ok: true, verificationRequired: true, email, codeExpiresAt: expiresAt }, cors), true;
        }

        const free = freeConfig();
        const freeExpiresAt = new Date(Date.now() + free.days * DAY_MS).toISOString();
        if (user) {
          db.prepare(`UPDATE users SET password_hash=?,status='active',email_verification_exempt=1,free_expires_at=COALESCE(free_expires_at,?),updated_at=? WHERE id=?`)
            .run(passwordHash, freeExpiresAt, nowIso(), user.id);
        } else {
          const result = db.prepare(`INSERT INTO users(email,password_hash,status,email_verification_exempt,free_expires_at,created_at,updated_at) VALUES(?,?,'active',1,?,?,?)`)
            .run(email, passwordHash, freeExpiresAt, nowIso(), nowIso());
          user = userById(Number(result.lastInsertRowid));
        }
        rateFailure('register-ip', req, EMAIL_IP_MAX, EMAIL_WINDOW_MS);
        rateFailure('register', req, EMAIL_MAX, EMAIL_WINDOW_MS, email);
        audit('account_registered', user.id, { emailDomain: email.split('@')[1], verificationRequired: false, freeExpiresAt });
        return json(res, 201, { ok: true, verificationRequired: false, email, freeExpiresAt }, cors), true;
      }

      if (path === '/api/v1/auth/resend-verification' && req.method === 'POST') {
        const input = await bodyJson(req);
        if (!extensionAllowed(req, input.extensionId)) fail(403, 'EXTENSION_NOT_ALLOWED', '只允许官方 GPTWork 扩展使用');
        const email = normalizeEmail(input.email);
        rateCheck('email-ip', req, EMAIL_IP_MAX, EMAIL_WINDOW_MS);
        rateCheck('email', req, EMAIL_MAX, EMAIL_WINDOW_MS, email);
        const user = userByEmail(email);
        if (user && !user.email_verified_at) await issueCode(user, 'verify_email');
        rateFailure('email-ip', req, EMAIL_IP_MAX, EMAIL_WINDOW_MS);
        rateFailure('email', req, EMAIL_MAX, EMAIL_WINDOW_MS, email);
        return json(res, 200, { ok: true, message: '如果邮箱待验证，验证码已发送' }, cors), true;
      }

      if (path === '/api/v1/auth/verify-email' && req.method === 'POST') {
        const input = await bodyJson(req);
        if (!extensionAllowed(req, input.extensionId)) fail(403, 'EXTENSION_NOT_ALLOWED', '只允许官方 GPTWork 扩展使用');
        const user = userByEmail(input.email);
        if (!user) fail(400, 'CODE_INVALID', '验证码错误或已失效');
        consumeEmailToken(user, 'verify_email', input.code);
        const free = freeConfig();
        const freeExpiresAt = new Date(Date.now() + free.days * DAY_MS).toISOString();
        db.prepare(`UPDATE users SET email_verified_at=COALESCE(email_verified_at,?),status='active',free_expires_at=COALESCE(free_expires_at,?),updated_at=? WHERE id=?`)
          .run(nowIso(), freeExpiresAt, nowIso(), user.id);
        audit('email_verified', user.id, { freeExpiresAt });
        return json(res, 200, { ok: true, verified: true, freeExpiresAt }, cors), true;
      }

      if (path === '/api/v1/auth/login' && req.method === 'POST') {
        const input = await bodyJson(req);
        if (!extensionAllowed(req, input.extensionId)) fail(403, 'EXTENSION_NOT_ALLOWED', '只允许官方 GPTWork 扩展登录');
        const email = normalizeEmail(input.email);
        rateCheck('login-ip', req, LOGIN_IP_MAX, LOGIN_WINDOW_MS);
        rateCheck('login', req, LOGIN_MAX, LOGIN_WINDOW_MS, email);
        const user = userByEmail(email);
        const verificationHash = user?.password_hash || await dummyPasswordHashPromise;
        const passwordMatches = await verifyPassword(input.password, verificationHash);
        const valid = Boolean(user && passwordMatches);
        if (!valid) {
          rateFailure('login-ip', req, LOGIN_IP_MAX, LOGIN_WINDOW_MS);
          rateFailure('login', req, LOGIN_MAX, LOGIN_WINDOW_MS, email);
          audit('login_failed', user?.id || null, { emailHash: sha256(email).slice(0, 16), ip: clientIp(req) });
          fail(401, 'LOGIN_FAILED', '邮箱或密码错误');
        }
        if (!emailAccessSatisfied(user)) fail(403, 'EMAIL_NOT_VERIFIED', '邮箱尚未验证');
        if (user.status === 'disabled') fail(403, 'ACCOUNT_DISABLED', '账号已被停用');
        rateClear('login', req, email);
        const issued = issueSession(user, input);
        return json(res, 200, { ok: true, sessionToken: issued.token, account: issued.account, heartbeatSeconds: issued.heartbeatSeconds }, cors), true;
      }

      if (path === '/api/v1/auth/forgot-password' && req.method === 'POST') {
        const input = await bodyJson(req);
        if (!extensionAllowed(req, input.extensionId)) fail(403, 'EXTENSION_NOT_ALLOWED', '只允许官方 GPTWork 扩展使用');
        const email = normalizeEmail(input.email);
        rateCheck('reset-email-ip', req, EMAIL_IP_MAX, EMAIL_WINDOW_MS);
        rateCheck('reset-email', req, EMAIL_MAX, EMAIL_WINDOW_MS, email);
        const user = userByEmail(email);
        if (user && user.status !== 'disabled') await issueCode(user, 'reset_password');
        rateFailure('reset-email-ip', req, EMAIL_IP_MAX, EMAIL_WINDOW_MS);
        rateFailure('reset-email', req, EMAIL_MAX, EMAIL_WINDOW_MS, email);
        return json(res, 200, { ok: true, message: '如果该邮箱已注册，重置验证码已发送' }, cors), true;
      }

      if (path === '/api/v1/auth/reset-password' && req.method === 'POST') {
        const input = await bodyJson(req);
        if (!extensionAllowed(req, input.extensionId)) fail(403, 'EXTENSION_NOT_ALLOWED', '只允许官方 GPTWork 扩展使用');
        if (!passwordValid(input.newPassword)) fail(400, 'WEAK_PASSWORD', '新密码至少 10 位');
        const user = userByEmail(input.email);
        if (!user || user.status === 'disabled') fail(400, 'CODE_INVALID', '验证码错误或已失效');
        consumeEmailToken(user, 'reset_password', input.code);
        const newPasswordHash = await encodePassword(input.newPassword);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(newPasswordHash, nowIso(), user.id);
          db.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(nowIso(), user.id);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        audit('password_reset', user.id);
        return json(res, 200, { ok: true, reset: true }, cors), true;
      }

      if (path === '/api/v1/account/me' && req.method === 'GET') {
        const session = requireSession(req);
        db.prepare('UPDATE user_sessions SET last_seen_at=? WHERE id=?').run(nowIso(), session.id);
        return json(res, 200, { ok: true, account: accountSummary(userById(session.user_id), session) }, cors), true;
      }

      if (path === '/api/v1/account/logout' && req.method === 'POST') {
        const session = sessionFromToken(bearer(req));
        if (session) {
          db.prepare('UPDATE user_sessions SET revoked_at=? WHERE id=?').run(nowIso(), session.id);
          db.prepare('DELETE FROM user_window_leases WHERE session_id=?').run(session.id);
          audit('logout', session.user_id, { sessionId: session.id });
        }
        return json(res, 200, { ok: true }, cors), true;
      }

      if (path === '/api/v1/account/security' && req.method === 'GET') {
        const session = requireSession(req);
        return json(res, 200, { ok: true, security: securitySnapshot(session.user_id, session) }, cors), true;
      }

      if (path === '/api/v1/account/devices/release' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        releaseDeviceRecord(session.user_id, input.deviceRecordId, { currentSession: session });
        return json(res, 200, { ok: true, security: securitySnapshot(session.user_id, session) }, cors), true;
      }

      if (path === '/api/v1/account/sessions/revoke' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        const targetId = Number(input.sessionId);
        if (!Number.isInteger(targetId) || targetId <= 0) fail(400, 'INVALID_SESSION', '登录会话无效');
        if (targetId === session.id) fail(409, 'CURRENT_SESSION', '不能从此入口注销当前会话，请使用退出登录');
        const target = db.prepare('SELECT * FROM user_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL').get(targetId, session.user_id);
        if (!target) fail(404, 'SESSION_NOT_FOUND', '登录会话不存在或已经失效');
        db.prepare('DELETE FROM user_window_leases WHERE session_id=?').run(target.id);
        db.prepare('UPDATE user_sessions SET revoked_at=? WHERE id=?').run(nowIso(), target.id);
        audit('session_revoked_by_user', session.user_id, { sessionId: target.id });
        return json(res, 200, { ok: true, security: securitySnapshot(session.user_id, session) }, cors), true;
      }

      if (path === '/api/v1/account/sessions/revoke-others' && req.method === 'POST') {
        const session = requireSession(req);
        const others = db.prepare('SELECT id FROM user_sessions WHERE user_id=? AND id<>? AND revoked_at IS NULL').all(session.user_id, session.id);
        for (const row of others) db.prepare('DELETE FROM user_window_leases WHERE session_id=?').run(row.id);
        db.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL').run(nowIso(), session.user_id, session.id);
        audit('other_sessions_revoked_by_user', session.user_id, { revokedCount: others.length });
        return json(res, 200, { ok: true, revokedCount: others.length, security: securitySnapshot(session.user_id, session) }, cors), true;
      }

      if (path === '/api/v1/account/change-password' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        if (!await verifyPassword(input.currentPassword, session.user.password_hash)) fail(401, 'PASSWORD_MISMATCH', '当前密码错误');
        if (!passwordValid(input.newPassword)) fail(400, 'WEAK_PASSWORD', '新密码至少 10 位');
        const newPasswordHash = await encodePassword(input.newPassword);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(newPasswordHash, nowIso(), session.user_id);
          db.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL').run(nowIso(), session.user_id, session.id);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        audit('password_changed', session.user_id, { currentSessionKept: true });
        return json(res, 200, { ok: true }, cors), true;
      }

      if (path === '/api/v1/account/heartbeat' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        const user = userById(session.user_id);
        const entitlement = entitlementFor(user);
        const requested = [...new Set(Array.isArray(input.windowKeys)
          ? input.windowKeys.filter((key) => validId(key, 220)).slice(0, 128) : [])];
        purgeWindowLeases();
        // Window leases are telemetry/liveness records only. Account entitlement may
        // enable GPTWork, but concurrent Chrome window count is intentionally unlimited.
        const allowed = entitlement.active ? requested : [];
        const now = nowIso();
        db.prepare('DELETE FROM user_window_leases WHERE session_id=?').run(session.id);
        const insert = db.prepare('INSERT INTO user_window_leases(session_id,window_key,first_seen_at,last_seen_at) VALUES(?,?,?,?)');
        for (const key of allowed) insert.run(session.id, key, now, now);
        db.prepare('UPDATE user_sessions SET last_seen_at=?,extension_version=? WHERE id=?')
          .run(now, String(input.extensionVersion || session.extension_version).slice(0, 40), session.id);
        db.prepare('UPDATE user_devices SET last_seen_at=? WHERE user_id=? AND device_id=?').run(now, session.user_id, session.device_id);
        const account = accountSummary(userById(session.user_id), sessionFromToken(bearer(req)));
        return json(res, 200, {
          ok: true,
          authorized: Boolean(account.entitlement.active),
          allowedWindowKeys: allowed,
          deniedWindowKeys: requested.filter((key) => !allowed.includes(key)),
          account,
          heartbeatSeconds: 60,
          windowLeaseTtlSeconds: windowTtlSeconds,
        }, cors), true;
      }

      if (path === '/api/v1/account/orders' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        const plan = db.prepare('SELECT * FROM membership_plans WHERE code=? AND enabled=1').get(String(input.planCode || ''));
        if (!plan) fail(404, 'PLAN_NOT_FOUND', '会员套餐不存在或已下架');
        const method = db.prepare('SELECT * FROM payment_methods WHERE code=? AND enabled=1').get(String(input.paymentMethod || ''));
        if (!method) fail(400, 'PAYMENT_METHOD_UNAVAILABLE', '支付方式未启用');
        const payUrl = normalizeHttpsUrl(method.pay_url) || '';
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        const frozenTerms = planSnapshotFromRow(plan);
        const result = db.prepare(`INSERT INTO membership_orders(user_id,plan_code,payment_method,amount_cents,status,pay_url,created_at,expires_at,plan_snapshot_json)
          VALUES(?,?,?,?, 'pending',?,?,?,?)`).run(session.user_id, plan.code, method.code, plan.price_cents, payUrl, nowIso(), expiresAt, JSON.stringify(frozenTerms));
        let order = db.prepare('SELECT * FROM membership_orders WHERE id=?').get(Number(result.lastInsertRowid));
        if (paymentSystem) order = await paymentSystem.prepareOrder(order, { clientIp: clientIp(req), userAgent: req.headers['user-agent'] || '' });
        audit('order_created', session.user_id, { orderId: order.id, planCode: plan.code, paymentMethod: method.code, amountCents: plan.price_cents });
        return json(res, 201, { ok: true, order: orderPublic(order), instructions: method.instructions }, cors), true;
      }

      const orderMatch = path.match(/^\/api\/v1\/account\/orders\/(\d+)$/);
      if (orderMatch && req.method === 'GET') {
        const session = requireSession(req);
        const order = db.prepare('SELECT * FROM membership_orders WHERE id=? AND user_id=?').get(Number(orderMatch[1]), session.user_id);
        if (!order) fail(404, 'ORDER_NOT_FOUND', '订单不存在');
        if (order.status === 'pending' && order.payment_method !== 'usdt' && Date.parse(order.expires_at) <= Date.now()) {
          db.prepare(`UPDATE membership_orders SET status='expired' WHERE id=? AND status='pending'`).run(order.id);
        }
        return json(res, 200, { ok: true, order: orderPublic(db.prepare('SELECT * FROM membership_orders WHERE id=?').get(order.id)) }, cors), true;
      }

      return false;
    } catch (error) {
      if (error instanceof AccountError) {
        replyError(res, error.status, error.code, error.message, cors, error.details);
        return true;
      }
      throw error;
    }
  }

  function adminSettingsPublic() {
    const smtp = smtpConfig();
    return {
      free: freeConfig(),
      sessionDays: sessionDays(),
      emailVerificationRequired: emailVerificationRequired(),
      smtp: {
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        username: smtp.username,
        fromEmail: smtp.fromEmail,
        fromName: smtp.fromName,
        passwordConfigured: Boolean(smtp.password),
      },
      paymentMethods: db.prepare('SELECT * FROM payment_methods ORDER BY code').all().map((row) => ({
        code: row.code, name: row.name, enabled: Boolean(row.enabled), payUrl: row.pay_url, instructions: row.instructions,
      })),
    };
  }

  function adminUserRow(user) {
    const membership = currentMembership(user.id);
    const entitlement = entitlementFor(user);
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      emailVerified: Boolean(user.email_verified_at),
      emailVerificationExempt: Boolean(user.email_verification_exempt),
      freeExpiresAt: user.free_expires_at,
      membership: membershipPublic(membership),
      entitlement,
      overrides: { devices: user.max_devices_override, windows: user.max_windows_override },
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
    };
  }

  async function handleAdmin(req, res, url) {
    const path = url.pathname;
    if (!path.startsWith('/admin/api/account/')) return false;
    try {
      if (path === '/admin/api/account/dashboard' && req.method === 'GET') {
        const total = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
        const verified = db.prepare('SELECT COUNT(*) AS count FROM users WHERE email_verified_at IS NOT NULL').get().count;
        const disabled = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE status='disabled'`).get().count;
        const activeMemberships = db.prepare(`SELECT COUNT(*) AS count FROM memberships WHERE status='active' AND starts_at<=? AND expires_at>?`).get(nowIso(), nowIso()).count;
        const pendingOrders = db.prepare(`SELECT COUNT(*) AS count FROM membership_orders WHERE status='pending' AND expires_at>?`).get(nowIso()).count;
        return json(res, 200, { ok: true, stats: { totalUsers: total, verifiedUsers: verified, disabledUsers: disabled, activeMemberships, pendingOrders } }), true;
      }

      if (path === '/admin/api/account/users' && req.method === 'POST') {
        const input = await bodyJson(req);
        const email = normalizeEmail(input.email);
        if (!isEmail(email)) fail(400, 'INVALID_EMAIL', '请输入有效邮箱');
        if (!passwordValid(input.password)) fail(400, 'WEAK_PASSWORD', '初始密码至少 10 位');
        if (userByEmail(email)) fail(409, 'ACCOUNT_EXISTS', '该邮箱已存在');

        const emailAccess = ['verified', 'exempt', 'pending'].includes(input.emailAccess) ? input.emailAccess : 'verified';
        const freeDays = clampInt(input.freeDays, 0, 3650, freeConfig().days);
        const optionalLimit = (value, code, label) => {
          if (value === undefined || value === null || value === '') return null;
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) fail(400, code, `${label}必须是 1–1000 的整数`);
          return parsed;
        };
        const maxDevicesOverride = optionalLimit(input.maxDevicesOverride, 'INVALID_DEVICE_LIMIT', '设备上限');
        const maxWindowsOverride = optionalLimit(input.maxWindowsOverride, 'INVALID_WINDOW_LIMIT', '窗口上限');
        const passwordHash = await encodePassword(input.password);
        const createdAt = nowIso();
        const active = emailAccess !== 'pending';
        const freeExpiresAt = active ? new Date(Date.now() + freeDays * DAY_MS).toISOString() : null;
        const emailVerifiedAt = emailAccess === 'verified' ? createdAt : null;
        const emailVerificationExempt = emailAccess === 'exempt' ? 1 : 0;
        const status = active ? 'active' : 'pending';

        const result = db.prepare(`INSERT INTO users(
          email,password_hash,status,email_verified_at,email_verification_exempt,free_expires_at,
          max_devices_override,max_windows_override,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
          email, passwordHash, status, emailVerifiedAt, emailVerificationExempt, freeExpiresAt,
          maxDevicesOverride, maxWindowsOverride, createdAt, createdAt,
        );
        const user = userById(Number(result.lastInsertRowid));
        audit('admin_user_created', user.id, {
          emailDomain: email.split('@')[1], emailAccess, freeDays, freeExpiresAt,
          maxDevicesOverride, maxWindowsOverride,
        });
        return json(res, 201, { ok: true, user: adminUserRow(user) }), true;
      }

      if (path === '/admin/api/account/users' && req.method === 'GET') {
        const query = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 120);
        const limit = clampInt(url.searchParams.get('limit'), 1, 1000, 300);
        const rows = query
          ? db.prepare('SELECT * FROM users WHERE email LIKE ? ORDER BY id DESC LIMIT ?').all(`%${query.replace(/[%_]/g, '')}%`, limit)
          : db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT ?').all(limit);
        return json(res, 200, { ok: true, users: rows.map(adminUserRow) }), true;
      }

      const userMatch = path.match(/^\/admin\/api\/account\/users\/(\d+)$/);
      if (userMatch && req.method === 'GET') {
        const user = userById(Number(userMatch[1]));
        if (!user) fail(404, 'USER_NOT_FOUND', '用户不存在');
        const memberships = db.prepare(`${MEMBERSHIP_SELECT} WHERE m.user_id=? ORDER BY m.id DESC LIMIT 50`).all(user.id)
          .map(hydrateMembership).map(membershipPublic);
        const devices = db.prepare('SELECT id,device_id,platform,first_seen_at,last_seen_at FROM user_devices WHERE user_id=? ORDER BY last_seen_at DESC').all(user.id);
        return json(res, 200, { ok: true, user: adminUserRow(user), memberships, devices }), true;
      }
      if (userMatch && req.method === 'PATCH') {
        const user = userById(Number(userMatch[1]));
        if (!user) fail(404, 'USER_NOT_FOUND', '用户不存在');
        const input = await bodyJson(req);
        let email = user.email;
        if (input.email !== undefined) {
          email = normalizeEmail(input.email);
          if (!isEmail(email)) fail(400, 'INVALID_EMAIL', '请输入有效邮箱');
          const duplicate = userByEmail(email);
          if (duplicate && duplicate.id !== user.id) fail(409, 'ACCOUNT_EXISTS', '该邮箱已被其他用户使用');
        }
        const status = ['active', 'disabled', 'pending'].includes(input.status) ? input.status : user.status;
        let freeExpiresAt = input.freeExpiresAt === null ? null : (parseIso(input.freeExpiresAt) || user.free_expires_at);
        const membership = currentMembership(user.id);
        let membershipExpiresAt = membership?.expires_at || null;
        let updateMembershipExpiry = false;
        if (Object.prototype.hasOwnProperty.call(input, 'entitlementExpiresAt')) {
          if (membership) {
            const parsed = parseIso(input.entitlementExpiresAt);
            if (!parsed) fail(400, 'INVALID_ENTITLEMENT_EXPIRY', '会员有效期不能为空且必须是有效日期');
            if (Date.parse(parsed) <= Date.parse(membership.starts_at)) fail(400, 'INVALID_ENTITLEMENT_EXPIRY', '会员有效期必须晚于会员开始时间');
            membershipExpiresAt = parsed;
            updateMembershipExpiry = true;
          } else {
            freeExpiresAt = input.entitlementExpiresAt === null ? null : parseIso(input.entitlementExpiresAt);
            if (input.entitlementExpiresAt !== null && !freeExpiresAt) fail(400, 'INVALID_ENTITLEMENT_EXPIRY', '免费权益有效期格式无效');
          }
        }
        const maxDevicesOverride = input.maxDevicesOverride === null ? null : clampInt(input.maxDevicesOverride, 1, 1000, user.max_devices_override ?? 1);
        const maxWindowsOverride = input.maxWindowsOverride === null ? null : clampInt(input.maxWindowsOverride, 1, 1000, user.max_windows_override ?? 1);
        const changedAt = nowIso();
        db.exec('BEGIN IMMEDIATE');
        try {
          if (updateMembershipExpiry) {
            db.prepare('UPDATE memberships SET expires_at=? WHERE id=?').run(membershipExpiresAt, membership.id);
          }
          db.prepare(`UPDATE users SET email=?,status=?,free_expires_at=?,max_devices_override=?,max_windows_override=?,updated_at=? WHERE id=?`)
            .run(email, status, freeExpiresAt, maxDevicesOverride, maxWindowsOverride, changedAt, user.id);
          if (status === 'disabled') {
            db.prepare('DELETE FROM user_window_leases WHERE session_id IN (SELECT id FROM user_sessions WHERE user_id=?)').run(user.id);
            db.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(changedAt, user.id);
          }
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        audit('admin_user_updated', user.id, {
          emailChanged: email !== user.email, status, freeExpiresAt, membershipId: membership?.id || null,
          membershipExpiresAt, maxDevicesOverride, maxWindowsOverride,
        });
        return json(res, 200, { ok: true, user: adminUserRow(userById(user.id)) }), true;
      }

      const adminPasswordMatch = path.match(/^\/admin\/api\/account\/users\/(\d+)\/password$/);
      if (adminPasswordMatch && req.method === 'POST') {
        const user = userById(Number(adminPasswordMatch[1]));
        if (!user) fail(404, 'USER_NOT_FOUND', '用户不存在');
        const input = await bodyJson(req);
        if (!passwordValid(input.password)) fail(400, 'WEAK_PASSWORD', '新密码至少 10 位，最多 128 位');
        const passwordHash = await encodePassword(input.password);
        const changedAt = nowIso();
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(passwordHash, changedAt, user.id);
          db.prepare('DELETE FROM user_window_leases WHERE session_id IN (SELECT id FROM user_sessions WHERE user_id=?)').run(user.id);
          db.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(changedAt, user.id);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        audit('admin_user_password_changed', user.id, { allSessionsRevoked: true });
        return json(res, 200, { ok: true, user: adminUserRow(userById(user.id)), sessionsRevoked: true }), true;
      }

      const resetDevicesMatch = path.match(/^\/admin\/api\/account\/users\/(\d+)\/reset-devices$/);
      if (resetDevicesMatch && req.method === 'POST') {
        const user = userById(Number(resetDevicesMatch[1]));
        if (!user) fail(404, 'USER_NOT_FOUND', '用户不存在');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM user_sessions WHERE user_id=?').run(user.id);
          db.prepare('DELETE FROM user_devices WHERE user_id=?').run(user.id);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        audit('admin_devices_reset', user.id);
        return json(res, 200, { ok: true }), true;
      }

      const grantMatch = path.match(/^\/admin\/api\/account\/users\/(\d+)\/grant-membership$/);
      if (grantMatch && req.method === 'POST') {
        const user = userById(Number(grantMatch[1]));
        if (!user) fail(404, 'USER_NOT_FOUND', '用户不存在');
        const input = await bodyJson(req);
        const membership = grantMembership(user.id, input.planCode, 'admin');
        return json(res, 201, { ok: true, membership: membershipPublic(membership), user: adminUserRow(userById(user.id)) }), true;
      }

      const revokeMembershipMatch = path.match(/^\/admin\/api\/account\/memberships\/(\d+)\/revoke$/);
      if (revokeMembershipMatch && req.method === 'POST') {
        const row = db.prepare('SELECT * FROM memberships WHERE id=?').get(Number(revokeMembershipMatch[1]));
        if (!row) fail(404, 'MEMBERSHIP_NOT_FOUND', '会员记录不存在');
        db.prepare(`UPDATE memberships SET status='revoked' WHERE id=?`).run(row.id);
        audit('admin_membership_revoked', row.user_id, { membershipId: row.id });
        return json(res, 200, { ok: true }), true;
      }

      if (path === '/admin/api/account/plans' && req.method === 'GET') {
        const plans = db.prepare('SELECT * FROM membership_plans ORDER BY sort_order,code').all().map((row) => {
          let benefits = [];
          try { benefits = JSON.parse(row.benefits_json || '[]'); } catch {}
          return { code: row.code, name: row.name, priceCents: row.price_cents, durationDays: row.duration_days,
            limits: { devices: row.max_devices, windows: row.max_windows }, benefits, enabled: Boolean(row.enabled), sortOrder: row.sort_order };
        });
        return json(res, 200, { ok: true, plans }), true;
      }
      const planMatch = path.match(/^\/admin\/api\/account\/plans\/([a-z0-9_-]{2,32})$/);
      if (planMatch && req.method === 'PUT') {
        const plan = db.prepare('SELECT * FROM membership_plans WHERE code=?').get(planMatch[1]);
        if (!plan) fail(404, 'PLAN_NOT_FOUND', '会员套餐不存在');
        const input = await bodyJson(req);
        const name = String(input.name || plan.name).slice(0, 120);
        const priceCents = clampInt(input.priceCents, 0, 100000000, plan.price_cents);
        const durationDays = clampInt(input.durationDays, 1, 3650, plan.duration_days);
        const maxDevices = clampInt(input.maxDevices, 1, 1000, plan.max_devices);
        const maxWindows = clampInt(input.maxWindows, 1, 1000, plan.max_windows);
        const benefits = Array.isArray(input.benefits) ? input.benefits.map((item) => String(item).slice(0, 160)).slice(0, 20) : JSON.parse(plan.benefits_json || '[]');
        const enabled = input.enabled === undefined ? plan.enabled : (input.enabled ? 1 : 0);
        db.prepare(`UPDATE membership_plans SET name=?,price_cents=?,duration_days=?,max_devices=?,max_windows=?,benefits_json=?,enabled=?,updated_at=? WHERE code=?`)
          .run(name, priceCents, durationDays, maxDevices, maxWindows, JSON.stringify(benefits), enabled, nowIso(), plan.code);
        audit('admin_plan_updated', null, { planCode: plan.code, priceCents, durationDays, maxDevices, maxWindows, enabled: Boolean(enabled) });
        return json(res, 200, { ok: true }), true;
      }

      if (path === '/admin/api/account/settings' && req.method === 'GET') {
        return json(res, 200, { ok: true, settings: adminSettingsPublic() }), true;
      }
      if (path === '/admin/api/account/settings' && req.method === 'PUT') {
        const input = await bodyJson(req);
        const free = input.free || {};
        setSetting('account_free_days', clampInt(free.days, 0, 3650, freeConfig().days));
        setSetting('account_free_max_devices', clampInt(free.maxDevices, 1, 1000, freeConfig().maxDevices));
        setSetting('account_free_max_windows', clampInt(free.maxWindows, 1, 1000, freeConfig().maxWindows));
        setSetting('account_session_days', clampInt(input.sessionDays, 1, 365, sessionDays()));
        if (input.emailVerificationRequired !== undefined) {
          setSetting('account_email_verification_required', input.emailVerificationRequired ? '1' : '0');
        }

        const smtp = input.smtp || {};
        if (smtp.host !== undefined) {
          const host = String(smtp.host || '').trim();
          if (host && (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || host.startsWith('.') || host.endsWith('.'))) fail(400, 'INVALID_SMTP_HOST', 'SMTP 主机格式无效');
          setSetting('smtp_host', host);
        }
        if (smtp.port !== undefined) setSetting('smtp_port', clampInt(smtp.port, 1, 65535, smtpConfig().port));
        if (smtp.secure !== undefined) setSetting('smtp_secure', smtp.secure ? '1' : '0');
        if (smtp.username !== undefined) setSetting('smtp_username', String(smtp.username || '').trim().slice(0, 254));
        if (smtp.fromEmail !== undefined) {
          const fromEmail = normalizeEmail(smtp.fromEmail);
          if (fromEmail && !isEmail(fromEmail)) fail(400, 'INVALID_SMTP_FROM', '发件邮箱格式无效');
          setSetting('smtp_from_email', fromEmail);
        }
        if (smtp.fromName !== undefined) setSetting('smtp_from_name', String(smtp.fromName || 'GPTWork').replace(/[\r\n]/g, ' ').slice(0, 120));
        if (smtp.password !== undefined && String(smtp.password)) setSecureSetting('smtp_password', String(smtp.password).slice(0, 512));
        if (smtp.clearPassword === true) setSecureSetting('smtp_password', '');

        if (Array.isArray(input.paymentMethods)) {
          for (const method of input.paymentMethods) {
            if (!['wechat', 'alipay'].includes(method.code)) continue;
            const payUrl = normalizeHttpsUrl(method.payUrl);
            if (payUrl === null) fail(400, 'INVALID_PAYMENT_URL', '支付跳转地址必须为空或 HTTPS 地址');
            db.prepare(`UPDATE payment_methods SET enabled=?,pay_url=?,instructions=?,updated_at=? WHERE code=?`)
              .run(method.enabled ? 1 : 0, payUrl, String(method.instructions || '').slice(0, 500), nowIso(), method.code);
          }
        }
        audit('admin_account_settings_updated', null, {
          smtpConfigured: smtpConfigured(), free: freeConfig(), sessionDays: sessionDays(),
          emailVerificationRequired: emailVerificationRequired(),
        });
        return json(res, 200, { ok: true, settings: adminSettingsPublic() }), true;
      }

      if (path === '/admin/api/account/settings/test-email' && req.method === 'POST') {
        const input = await bodyJson(req);
        const email = normalizeEmail(input.email);
        if (!isEmail(email)) fail(400, 'INVALID_EMAIL', '请输入有效测试邮箱');
        if (TEST_EMAIL_MODE) {
          testOutbox.push({ to: email, purpose: 'test', subject: 'GPTWork 邮箱配置测试', text: 'SMTP 配置测试成功。', createdAt: nowIso() });
        } else {
          if (!smtpConfigured()) fail(503, 'EMAIL_NOT_CONFIGURED', 'SMTP 尚未完整配置');
          await sendSmtpMail(smtpConfig(), { to: email, subject: 'GPTWork 邮箱配置测试', text: '如果您收到这封邮件，说明 GPTWork SMTP 配置工作正常。' });
        }
        return json(res, 200, { ok: true }), true;
      }

      if (path === '/admin/api/account/orders' && req.method === 'GET') {
        const rows = db.prepare(`SELECT o.*,u.email,p.name AS plan_name,pm.name AS payment_name FROM membership_orders o
          JOIN users u ON u.id=o.user_id JOIN membership_plans p ON p.code=o.plan_code JOIN payment_methods pm ON pm.code=o.payment_method
          ORDER BY o.id DESC LIMIT 500`).all();
        return json(res, 200, { ok: true, orders: rows.map((row) => {
          const order = orderPublic(row);
          return { ...order, email: row.email, planName: order.planSnapshot.name, paymentName: row.payment_name };
        }) }), true;
      }
      const paidMatch = path.match(/^\/admin\/api\/account\/orders\/(\d+)\/mark-paid$/);
      if (paidMatch && req.method === 'POST') {
        const order = markOrderPaid(db.prepare('SELECT * FROM membership_orders WHERE id=?').get(Number(paidMatch[1])));
        return json(res, 200, { ok: true, order: orderPublic(order) }), true;
      }
      const cancelMatch = path.match(/^\/admin\/api\/account\/orders\/(\d+)\/cancel$/);
      if (cancelMatch && req.method === 'POST') {
        const order = db.prepare('SELECT * FROM membership_orders WHERE id=?').get(Number(cancelMatch[1]));
        if (!order) fail(404, 'ORDER_NOT_FOUND', '订单不存在');
        if (order.status !== 'pending') fail(409, 'ORDER_NOT_PENDING', '只有待支付订单可以取消');
        db.prepare(`UPDATE membership_orders SET status='cancelled' WHERE id=?`).run(order.id);
        audit('admin_order_cancelled', order.user_id, { orderId: order.id });
        return json(res, 200, { ok: true }), true;
      }

      if (path === '/admin/api/account/audit' && req.method === 'GET') {
        const rows = db.prepare('SELECT * FROM account_audit_log ORDER BY id DESC LIMIT 500').all();
        return json(res, 200, { ok: true, audit: rows }), true;
      }

      if (TEST_EMAIL_MODE && path === '/admin/api/account/test-outbox' && req.method === 'GET') {
        return json(res, 200, { ok: true, messages: testOutbox.slice(-50) }), true;
      }

      return false;
    } catch (error) {
      if (error instanceof AccountError) {
        replyError(res, error.status, error.code, error.message);
        return true;
      }
      throw error;
    }
  }

  return {
    handleApi,
    handleAdmin,
    accountSummary,
    testOutbox,
    markOrderPaidById(orderId, context = {}) {
      const autoSource = context?.source === 'okx_auto' || context?.source === 'zpay_auto';
      const paid = markOrderPaid(db.prepare('SELECT * FROM membership_orders WHERE id=?').get(Number(orderId)), { allowExpiredPending: autoSource });
      if (context?.source === 'okx_auto') {
        audit('order_auto_paid_okx', paid.user_id, {
          orderId: paid.id, depositId: context.depositId || '', txId: context.txId || '',
          amount: context.amount || '', chain: context.chain || '', depositTs: context.depositTs || '',
        });
      }
      if (context?.source === 'zpay_auto') {
        audit('order_auto_paid_zpay', paid.user_id, {
          orderId: paid.id, tradeNo: context.tradeNo || '', merchantTradeNo: context.merchantTradeNo || '',
          channel: context.channel || '', amount: context.amount || '',
        });
      }
      return orderPublic(paid);
    },
  };
}
