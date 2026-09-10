import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { normalizePlanPricing } from './plan-pricing.mjs';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const DAY_MS = 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'gptlock_site_session';
const CHECKIN_REWARD_DAYS = 1;
const INVITE_REWARD_DAYS = 7;
const REWARD_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1000;

class SiteAccountError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function nowIso() { return new Date().toISOString(); }
function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
function passwordValid(value) { return typeof value === 'string' && value.length >= 10 && value.length <= 128; }
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
function cookie(req, name) {
  for (const item of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function rewardDayKey(at = Date.now()) {
  return new Date(at + REWARD_TIMEZONE_OFFSET_MS).toISOString().slice(0, 10);
}

export function createSiteAccountSystem({ db, env, publicOrigin, json, bodyJson, clientIp, accountSummary, paymentSystem }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE TABLE IF NOT EXISTS account_daily_checkins (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_key TEXT NOT NULL,
      reward_days INTEGER NOT NULL DEFAULT 1 CHECK(reward_days >= 1),
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, day_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS account_invite_codes (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS account_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      invitee_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      invite_code TEXT NOT NULL,
      reward_days INTEGER NOT NULL DEFAULT 7 CHECK(reward_days >= 1),
      created_at TEXT NOT NULL,
      rewarded_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_site_sessions_user ON site_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_site_sessions_token ON site_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_account_invites_inviter ON account_invites(inviter_user_id, rewarded_at);
  `);

  const attempts = new Map();
  const LOGIN_MAX = Math.max(3, Number(env.GPTLOCK_SITE_LOGIN_MAX_ATTEMPTS || 10));
  const LOGIN_WINDOW_MS = Math.max(60_000, Number(env.GPTLOCK_SITE_LOGIN_WINDOW_MS || 15 * 60 * 1000));

  function fail(status, code, message) { throw new SiteAccountError(status, code, message); }
  function userByEmail(email) { return db.prepare('SELECT * FROM users WHERE email=?').get(normalizeEmail(email)); }
  function userById(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(Number(id)); }
  function sessionDays() {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='account_session_days'").get();
    return clampInt(row?.value, 1, 365, 30);
  }
  function emailAccessSatisfied(user) { return Boolean(user?.email_verified_at || user?.email_verification_exempt); }
  function originAllowed(req) {
    const origin = String(req.headers.origin || '');
    return !origin || origin === publicOrigin;
  }
  function setCookie(token, maxAge) {
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
  }
  function clearCookie() { return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }
  function rateKey(req, email) { return `${clientIp(req)}:${sha256(normalizeEmail(email)).slice(0, 20)}`; }
  function checkRate(req, email) {
    const key = rateKey(req, email);
    const now = Date.now();
    const row = attempts.get(key);
    if (!row || row.resetAt <= now) {
      attempts.delete(key);
      return;
    }
    if (row.count >= LOGIN_MAX) fail(429, 'RATE_LIMITED', '登录失败次数过多，请稍后再试');
  }
  function recordFailure(req, email) {
    const key = rateKey(req, email);
    const now = Date.now();
    const row = attempts.get(key);
    attempts.set(key, row && row.resetAt > now
      ? { count: row.count + 1, resetAt: row.resetAt }
      : { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  }
  function clearFailures(req, email) { attempts.delete(rateKey(req, email)); }

  function sessionFromRequest(req) {
    const token = cookie(req, COOKIE_NAME);
    if (!token) return null;
    const row = db.prepare(`SELECT s.*,u.email,u.password_hash,u.status,u.email_verified_at,u.email_verification_exempt
      FROM site_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL`).get(sha256(token));
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now() || row.status === 'disabled') {
      db.prepare('UPDATE site_sessions SET revoked_at=? WHERE id=?').run(nowIso(), row.id);
      return null;
    }
    return row;
  }
  function requireSession(req) {
    const session = sessionFromRequest(req);
    if (!session) fail(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
    return session;
  }
  function issueSession(user, req) {
    const token = randomBytes(32).toString('base64url');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + sessionDays() * DAY_MS).toISOString();
    db.prepare(`INSERT INTO site_sessions(user_id,token_hash,created_at,last_seen_at,expires_at,ip,user_agent)
      VALUES(?,?,?,?,?,?,?)`).run(user.id, sha256(token), createdAt, createdAt, expiresAt,
        String(clientIp(req) || '').slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 240));
    db.prepare('UPDATE users SET last_login_at=?,updated_at=? WHERE id=?').run(createdAt, createdAt, user.id);
    return { token, expiresAt };
  }
  function extensionSecurity(userId) {
    const now = nowIso();
    const devices = db.prepare(`SELECT d.*,COUNT(CASE WHEN s.revoked_at IS NULL AND s.expires_at>? THEN 1 END) AS active_sessions
      FROM user_devices d LEFT JOIN user_sessions s ON s.user_id=d.user_id AND s.device_id=d.device_id
      WHERE d.user_id=? GROUP BY d.id ORDER BY d.last_seen_at DESC,d.id DESC`).all(now, userId).map((row) => ({
        id: row.id,
        platform: row.platform || 'unknown',
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        activeSessions: Number(row.active_sessions || 0),
      }));
    const sessions = db.prepare(`SELECT s.*,d.platform AS device_platform FROM user_sessions s
      LEFT JOIN user_devices d ON d.user_id=s.user_id AND d.device_id=s.device_id
      WHERE s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? ORDER BY s.last_seen_at DESC,s.id DESC`).all(userId, now).map((row) => ({
        id: row.id,
        platform: row.device_platform || row.platform || 'unknown',
        extensionVersion: row.extension_version || '',
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
      }));
    return { devices, sessions };
  }
  function siteSessions(userId, currentId) {
    return db.prepare(`SELECT id,created_at,last_seen_at,expires_at,ip,user_agent FROM site_sessions
      WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY last_seen_at DESC,id DESC`).all(userId, nowIso()).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        ip: row.ip,
        userAgent: row.user_agent,
        current: row.id === currentId,
      }));
  }
  function securitySnapshot(userId, currentSiteId) {
    return { ...extensionSecurity(userId), siteSessions: siteSessions(userId, currentSiteId) };
  }
  function plans() {
    return db.prepare('SELECT * FROM membership_plans WHERE enabled=1 ORDER BY sort_order,code').all().map((row) => {
      let benefits = [];
      try { benefits = JSON.parse(row.benefits_json || '[]'); } catch {}
      return { code: row.code, name: row.name, ...normalizePlanPricing(row), durationDays: row.duration_days,
        limits: { devices: row.max_devices }, benefits };
    });
  }
  function paymentMethods() {
    return paymentSystem.list(true);
  }
  function orderPublic(row) {
    if (!row) return null;
    let snapshot = {};
    try { snapshot = JSON.parse(row.plan_snapshot_json || '{}'); } catch {}
    return { id: row.id, planCode: row.plan_code, paymentMethod: row.payment_method, amountCents: row.amount_cents,
      status: row.status, payUrl: row.pay_url || '', createdAt: row.created_at, expiresAt: row.expires_at,
      paidAt: row.paid_at, membershipId: row.membership_id, planSnapshot: snapshot,
      payment: row.payment_method === 'usdt' ? paymentSystem.orderPaymentDetails(row.id) : paymentSystem.zpayOrderDetails(row.id) };
  }
  function listOrders(userId) {
    return db.prepare('SELECT * FROM membership_orders WHERE user_id=? ORDER BY id DESC LIMIT 20').all(userId).map(orderPublic);
  }
  function ensureInviteCode(userId) {
    const existing = db.prepare('SELECT code FROM account_invite_codes WHERE user_id=?').get(userId);
    if (existing?.code) return existing.code;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = `GW-${randomBytes(6).toString('base64url').toUpperCase()}`;
      try {
        db.prepare('INSERT INTO account_invite_codes(user_id,code,created_at) VALUES(?,?,?)').run(userId, code, nowIso());
        return code;
      } catch (error) {
        if (!String(error?.message || '').includes('UNIQUE')) throw error;
      }
    }
    fail(500, 'INVITE_CODE_UNAVAILABLE', '暂时无法生成邀请码，请稍后重试');
  }
  function extendRewardDays(userId, days) {
    const rewardDays = clampInt(days, 1, 3650, 1);
    const user = userById(userId);
    if (!user) fail(404, 'ACCOUNT_NOT_FOUND', '账户不存在');
    const membership = db.prepare("SELECT MAX(expires_at) AS expires_at FROM memberships WHERE user_id=? AND status='active'").get(userId);
    const baseMs = Math.max(
      Date.now(),
      Date.parse(user.free_expires_at || '') || 0,
      Date.parse(membership?.expires_at || '') || 0,
    );
    const expiresAt = new Date(baseMs + rewardDays * DAY_MS).toISOString();
    db.prepare('UPDATE users SET free_expires_at=?,updated_at=? WHERE id=?').run(expiresAt, nowIso(), userId);
    return expiresAt;
  }
  function rewardSnapshot(userId) {
    const code = ensureInviteCode(userId);
    const dayKey = rewardDayKey();
    const checked = db.prepare('SELECT created_at FROM account_daily_checkins WHERE user_id=? AND day_key=?').get(userId, dayKey);
    const checkins = db.prepare('SELECT COUNT(*) AS count FROM account_daily_checkins WHERE user_id=?').get(userId);
    const invites = db.prepare('SELECT COUNT(*) AS count FROM account_invites WHERE inviter_user_id=?').get(userId);
    const user = userById(userId);
    return {
      checkin: {
        dayKey,
        checkedInToday: Boolean(checked),
        checkedInAt: checked?.created_at || null,
        rewardDays: CHECKIN_REWARD_DAYS,
        totalCheckins: Number(checkins?.count || 0),
      },
      invite: {
        code,
        url: `${String(publicOrigin || '').replace(/\/$/, '')}/account?invite=${encodeURIComponent(code)}`,
        rewardDays: INVITE_REWARD_DAYS,
        successfulInvites: Number(invites?.count || 0),
      },
      bonusExpiresAt: user?.free_expires_at || null,
    };
  }
  function checkIn(userId) {
    const dayKey = rewardDayKey();
    const existing = db.prepare('SELECT created_at FROM account_daily_checkins WHERE user_id=? AND day_key=?').get(userId, dayKey);
    if (existing) return { alreadyCheckedIn: true, rewards: rewardSnapshot(userId) };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO account_daily_checkins(user_id,day_key,reward_days,created_at) VALUES(?,?,?,?)')
        .run(userId, dayKey, CHECKIN_REWARD_DAYS, nowIso());
      extendRewardDays(userId, CHECKIN_REWARD_DAYS);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return { alreadyCheckedIn: false, rewards: rewardSnapshot(userId) };
  }
  function redeemInvite(inviteeUserId, rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!/^GW-[A-Z0-9_-]{6,24}$/.test(code)) fail(400, 'INVALID_INVITE_CODE', '邀请码格式无效');
    const inviteCode = db.prepare('SELECT user_id,code FROM account_invite_codes WHERE code=?').get(code);
    if (!inviteCode) fail(404, 'INVITE_CODE_NOT_FOUND', '邀请码不存在或已失效');
    if (Number(inviteCode.user_id) === Number(inviteeUserId)) fail(409, 'SELF_INVITE_NOT_ALLOWED', '不能使用自己的邀请码');
    const existing = db.prepare('SELECT inviter_user_id,invite_code,rewarded_at FROM account_invites WHERE invitee_user_id=?').get(inviteeUserId);
    if (existing) {
      if (Number(existing.inviter_user_id) === Number(inviteCode.user_id)) {
        return { alreadyRedeemed: true, rewards: rewardSnapshot(inviteeUserId) };
      }
      fail(409, 'INVITE_ALREADY_REDEEMED', '当前账户已经绑定过其他邀请关系');
    }
    const inviter = userById(inviteCode.user_id);
    if (!inviter || inviter.status === 'disabled' || !emailAccessSatisfied(inviter)) fail(409, 'INVITER_UNAVAILABLE', '邀请人账户当前不可用');
    const redeemedAt = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO account_invites(inviter_user_id,invitee_user_id,invite_code,reward_days,created_at,rewarded_at)
        VALUES(?,?,?,?,?,?)`).run(inviteCode.user_id, inviteeUserId, code, INVITE_REWARD_DAYS, redeemedAt, redeemedAt);
      extendRewardDays(inviteCode.user_id, INVITE_REWARD_DAYS);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return { alreadyRedeemed: false, rewards: rewardSnapshot(inviteeUserId) };
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/site/api/')) return false;
    try {
      if (!['GET', 'HEAD'].includes(req.method || '') && !originAllowed(req)) fail(403, 'ORIGIN_MISMATCH', '请求来源校验失败');

      if (url.pathname === '/site/api/account/config' && req.method === 'GET') {
        return json(res, 200, { ok: true, plans: plans(), paymentMethods: paymentMethods() }), true;
      }
      if (url.pathname === '/site/api/auth/login' && req.method === 'POST') {
        const input = await bodyJson(req);
        const email = normalizeEmail(input.email);
        checkRate(req, email);
        const user = userByEmail(email);
        const valid = Boolean(user && await verifyPassword(input.password, user.password_hash));
        if (!valid) {
          recordFailure(req, email);
          fail(401, 'LOGIN_FAILED', '邮箱或密码错误');
        }
        if (!emailAccessSatisfied(user)) fail(403, 'EMAIL_NOT_VERIFIED', '邮箱尚未验证，请先在 GPTWork 插件中完成验证');
        if (user.status === 'disabled') fail(403, 'ACCOUNT_DISABLED', '账号已被停用');
        clearFailures(req, email);
        const issued = issueSession(user, req);
        return json(res, 200, { ok: true, account: accountSummary(user), expiresAt: issued.expiresAt }, {
          'set-cookie': setCookie(issued.token, sessionDays() * 24 * 60 * 60),
        }), true;
      }
      if (url.pathname === '/site/api/auth/logout' && req.method === 'POST') {
        const session = sessionFromRequest(req);
        if (session) db.prepare('UPDATE site_sessions SET revoked_at=? WHERE id=?').run(nowIso(), session.id);
        return json(res, 200, { ok: true }, { 'set-cookie': clearCookie() }), true;
      }
      if (url.pathname === '/site/api/account/me' && req.method === 'GET') {
        const session = requireSession(req);
        db.prepare('UPDATE site_sessions SET last_seen_at=? WHERE id=?').run(nowIso(), session.id);
        return json(res, 200, { ok: true, account: accountSummary(userById(session.user_id)),
          security: securitySnapshot(session.user_id, session.id), orders: listOrders(session.user_id), rewards: rewardSnapshot(session.user_id) }), true;
      }
      if (url.pathname === '/site/api/account/rewards' && req.method === 'GET') {
        const session = requireSession(req);
        return json(res, 200, { ok: true, rewards: rewardSnapshot(session.user_id) }), true;
      }
      if (url.pathname === '/site/api/account/checkin' && req.method === 'POST') {
        const session = requireSession(req);
        const result = checkIn(session.user_id);
        return json(res, 200, { ok: true, ...result, account: accountSummary(userById(session.user_id)) }), true;
      }
      if (url.pathname === '/site/api/account/invite/redeem' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        const result = redeemInvite(session.user_id, input.code);
        return json(res, 200, { ok: true, ...result }), true;
      }
      if (url.pathname === '/site/api/account/security' && req.method === 'GET') {
        const session = requireSession(req);
        return json(res, 200, { ok: true, security: securitySnapshot(session.user_id, session.id) }), true;
      }
      if (url.pathname === '/site/api/account/devices/release' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        const id = Number(input.deviceRecordId);
        if (!Number.isInteger(id) || id <= 0) fail(400, 'INVALID_DEVICE', '设备记录无效');
        const device = db.prepare('SELECT * FROM user_devices WHERE id=? AND user_id=?').get(id, session.user_id);
        if (!device) fail(404, 'DEVICE_NOT_FOUND', '设备不存在或已经释放');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM user_window_leases WHERE session_id IN (SELECT id FROM user_sessions WHERE user_id=? AND device_id=?)').run(session.user_id, device.device_id);
          db.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND device_id=? AND revoked_at IS NULL').run(nowIso(), session.user_id, device.device_id);
          db.prepare('DELETE FROM user_devices WHERE id=? AND user_id=?').run(id, session.user_id);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        return json(res, 200, { ok: true, security: securitySnapshot(session.user_id, session.id) }), true;
      }
      if (url.pathname === '/site/api/account/sessions/revoke' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        const id = Number(input.sessionId);
        const target = db.prepare('SELECT id FROM user_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL').get(id, session.user_id);
        if (!target) fail(404, 'SESSION_NOT_FOUND', '插件会话不存在或已经失效');
        db.prepare('DELETE FROM user_window_leases WHERE session_id=?').run(id);
        db.prepare('UPDATE user_sessions SET revoked_at=? WHERE id=?').run(nowIso(), id);
        return json(res, 200, { ok: true, security: securitySnapshot(session.user_id, session.id) }), true;
      }
      if (url.pathname === '/site/api/account/sessions/revoke-all' && req.method === 'POST') {
        const session = requireSession(req);
        db.prepare('DELETE FROM user_window_leases WHERE session_id IN (SELECT id FROM user_sessions WHERE user_id=?)').run(session.user_id);
        const result = db.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(nowIso(), session.user_id);
        return json(res, 200, { ok: true, revokedCount: Number(result.changes || 0), security: securitySnapshot(session.user_id, session.id) }), true;
      }
      if (url.pathname === '/site/api/account/site-sessions/revoke' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        const id = Number(input.sessionId);
        if (id === session.id) fail(409, 'CURRENT_SESSION', '当前网页登录请使用退出登录');
        const target = db.prepare('SELECT id FROM site_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL').get(id, session.user_id);
        if (!target) fail(404, 'SESSION_NOT_FOUND', '网页登录不存在或已经失效');
        db.prepare('UPDATE site_sessions SET revoked_at=? WHERE id=?').run(nowIso(), id);
        return json(res, 200, { ok: true, security: securitySnapshot(session.user_id, session.id) }), true;
      }
      if (url.pathname === '/site/api/account/change-password' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        if (!await verifyPassword(input.currentPassword, session.password_hash)) fail(401, 'PASSWORD_MISMATCH', '当前密码错误');
        if (!passwordValid(input.newPassword)) fail(400, 'WEAK_PASSWORD', '新密码至少 10 位，最多 128 位');
        if (safeEqual(input.currentPassword, input.newPassword)) fail(400, 'PASSWORD_UNCHANGED', '新密码不能与当前密码相同');
        const hash = await encodePassword(input.newPassword);
        const changedAt = nowIso();
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(hash, changedAt, session.user_id);
          db.prepare('DELETE FROM user_window_leases WHERE session_id IN (SELECT id FROM user_sessions WHERE user_id=?)').run(session.user_id);
          db.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(changedAt, session.user_id);
          db.prepare('UPDATE site_sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL').run(changedAt, session.user_id, session.id);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        return json(res, 200, { ok: true }), true;
      }
      if (url.pathname === '/site/api/account/delete' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        if (!await verifyPassword(input.currentPassword, session.password_hash)) fail(401, 'PASSWORD_MISMATCH', '当前密码错误');
        if (String(input.confirmText || '') !== 'DELETE') fail(400, 'DELETE_CONFIRMATION_REQUIRED', '请输入 DELETE 确认永久删除账户');
        const userId = session.user_id;
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM account_audit_log WHERE user_id=?').run(userId);
          const result = db.prepare('DELETE FROM users WHERE id=?').run(userId);
          if (Number(result.changes || 0) !== 1) fail(404, 'ACCOUNT_NOT_FOUND', '账户不存在或已删除');
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        return json(res, 200, { ok: true, deleted: true }, { 'set-cookie': clearCookie() }), true;
      }
      if (url.pathname === '/site/api/account/orders' && req.method === 'POST') {
        const session = requireSession(req);
        const input = await bodyJson(req);
        const plan = db.prepare('SELECT * FROM membership_plans WHERE code=? AND enabled=1').get(String(input.planCode || ''));
        if (!plan) fail(404, 'PLAN_NOT_FOUND', '会员套餐不存在或已下架');
        const method = db.prepare('SELECT * FROM payment_methods WHERE code=? AND enabled=1').get(String(input.paymentMethod || ''));
        if (!method) fail(400, 'PAYMENT_METHOD_UNAVAILABLE', '支付方式未启用');
        let benefits = [];
        try { benefits = JSON.parse(plan.benefits_json || '[]'); } catch {}
        const pricing = normalizePlanPricing(plan);
        const snapshot = { code: plan.code, name: plan.name, priceCents: pricing.priceCents, originalPriceCents: pricing.originalPriceCents, promoPriceCents: pricing.promoPriceCents, promoEndsAt: pricing.promoEndsAt, durationDays: plan.duration_days,
          maxDevices: plan.max_devices, maxWindows: plan.max_windows, benefits };
        const usdtQuote = method.code === 'usdt' ? paymentSystem.usdtQuote(plan.code) : null;
        const ttlMs = method.code === 'usdt' ? paymentSystem.usdtOrderTtlMs() : 30 * 60 * 1000;
        const expiresAt = new Date(Date.now() + ttlMs).toISOString();
        const result = db.prepare(`INSERT INTO membership_orders(user_id,plan_code,payment_method,amount_cents,status,pay_url,created_at,expires_at,plan_snapshot_json)
          VALUES(?,?,?,?, 'pending',?,?,?,?)`).run(session.user_id, plan.code, method.code, pricing.priceCents,
            method.pay_url || '', nowIso(), expiresAt, JSON.stringify(snapshot));
        let order = db.prepare('SELECT * FROM membership_orders WHERE id=?').get(Number(result.lastInsertRowid));
        if (usdtQuote) paymentSystem.attachUsdtOrder(order.id, usdtQuote);
        order = await paymentSystem.prepareOrder(order, { clientIp: clientIp(req), userAgent: req.headers['user-agent'] || '' });
        return json(res, 201, { ok: true, order: orderPublic(order), instructions: method.instructions || '' }), true;
      }
      const orderMatch = url.pathname.match(/^\/site\/api\/account\/orders\/(\d+)$/);
      if (orderMatch && req.method === 'GET') {
        const session = requireSession(req);
        const order = db.prepare('SELECT * FROM membership_orders WHERE id=? AND user_id=?').get(Number(orderMatch[1]), session.user_id);
        if (!order) fail(404, 'ORDER_NOT_FOUND', '订单不存在');
        if (order.status === 'pending' && order.payment_method !== 'usdt' && Date.parse(order.expires_at) <= Date.now()) {
          db.prepare("UPDATE membership_orders SET status='expired' WHERE id=? AND status='pending'").run(order.id);
        }
        return json(res, 200, { ok: true, order: orderPublic(db.prepare('SELECT * FROM membership_orders WHERE id=?').get(order.id)) }), true;
      }
      return false;
    } catch (error) {
      if (error instanceof SiteAccountError || (error?.status && error?.code)) {
        json(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
        return true;
      }
      throw error;
    }
  }

  return { handle };
}