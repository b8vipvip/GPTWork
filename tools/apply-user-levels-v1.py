from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MARKER = 'USER_LEVELS_V1'


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


def replace(path, old, new, count=1):
    text = read(path)
    if old not in text:
        raise RuntimeError(f'missing replacement in {path}: {old[:100]!r}')
    text = text.replace(old, new, count)
    write(path, text)


def sub(path, pattern, repl, count=1, flags=re.S):
    text = read(path)
    text2, n = re.subn(pattern, repl, text, count=count, flags=flags)
    if n != count:
        raise RuntimeError(f'pattern replacement count {n} != {count} in {path}: {pattern[:100]!r}')
    write(path, text2)


account = 'license-server/account-system.mjs'
if MARKER in read(account):
    print('user-level migration already applied')
    raise SystemExit(0)

# ---- Account backend: keep legacy membership tables only as order/history compatibility,
#      but make user_level + free_expires_at the active entitlement model. ----
sub(account, r"const DAY_MS = 24 \* 60 \* 60 \* 1000;\nconst DEFAULT_PLANS = \[.*?\n\];\n\nfunction nowIso", """const DAY_MS = 24 * 60 * 60 * 1000;
const CHECKIN_REWARD_DAYS = 1;
const SHARE_REWARD_DAYS = 7;
const REWARD_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1000;
const USER_LEVELS_V1 = true;
const USER_LEVEL_CODES = new Set(['normal', 'deep', 'heavy']);
const USER_LEVEL_RANK = { normal: 0, deep: 1, heavy: 2 };
const DEFAULT_PLANS = [
  {
    code: 'deep', name: '深度用户', priceCents: 1900, durationDays: 30,
    maxDevices: 1, maxWindows: 3, sortOrder: 20,
    benefits: ['1 台设备', '最多 3 个同时窗口', '完整 GPTWork 功能'],
  },
  {
    code: 'heavy', name: '重度用户', priceCents: 4900, durationDays: 30,
    maxDevices: 5, maxWindows: 5, sortOrder: 30,
    benefits: ['最多 5 台设备', '最多 5 个同时窗口', '完整 GPTWork 功能'],
  },
];

function nowIso""")
replace(account, "    free_expires_at TEXT,\n    max_devices_override", "    free_expires_at TEXT,\n    user_level TEXT NOT NULL DEFAULT 'normal',\n    max_devices_override")
replace(account, "  CREATE TABLE IF NOT EXISTS account_audit_log (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    event TEXT NOT NULL,\n    user_id INTEGER,\n    detail TEXT NOT NULL DEFAULT '',\n    created_at TEXT NOT NULL\n  ) STRICT;", """  CREATE TABLE IF NOT EXISTS account_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    user_id INTEGER,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
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
  ) STRICT;""")
replace(account, "  ensureColumn('users', 'email_verification_exempt', 'email_verification_exempt INTEGER NOT NULL DEFAULT 0 CHECK(email_verification_exempt IN (0,1))');", """  ensureColumn('users', 'email_verification_exempt', 'email_verification_exempt INTEGER NOT NULL DEFAULT 0 CHECK(email_verification_exempt IN (0,1))');
  ensureColumn('users', 'user_level', \"user_level TEXT NOT NULL DEFAULT 'normal'\");
  db.prepare(\"UPDATE users SET user_level='normal' WHERE user_level NOT IN ('normal','deep','heavy') OR user_level IS NULL\").run();""")
replace(account, "  for (const plan of DEFAULT_PLANS) {\n    insertPlan.run(plan.code, plan.name, plan.priceCents, plan.durationDays, plan.maxDevices, plan.maxWindows,\n      JSON.stringify(plan.benefits), 1, plan.sortOrder, nowIso());\n  }", """  for (const plan of DEFAULT_PLANS) {
    insertPlan.run(plan.code, plan.name, plan.priceCents, plan.durationDays, plan.maxDevices, plan.maxWindows,
      JSON.stringify(plan.benefits), 1, plan.sortOrder, nowIso());
  }
  // Legacy month/quarter/year products remain in the database only so historical
  // orders keep their foreign-key targets. They are no longer a public entitlement model.
  db.prepare(\"UPDATE membership_plans SET enabled=0 WHERE code IN ('monthly','quarterly','yearly')\").run();
  const levelMigration = db.prepare(\"SELECT value FROM app_settings WHERE key='account_user_level_migration_v1'\").get();
  if (!levelMigration) {
    const legacyRows = db.prepare(`SELECT m.user_id,m.expires_at,p.max_devices,p.max_windows
      FROM memberships m JOIN membership_plans p ON p.code=m.plan_code
      WHERE m.status='active' AND m.expires_at>? ORDER BY m.expires_at DESC`).all(nowIso());
    const migratedUsers = new Set();
    for (const row of legacyRows) {
      if (migratedUsers.has(row.user_id)) continue;
      migratedUsers.add(row.user_id);
      const level = Number(row.max_devices) >= 5 || Number(row.max_windows) >= 5 ? 'heavy' : 'deep';
      const user = db.prepare('SELECT free_expires_at FROM users WHERE id=?').get(row.user_id);
      const currentExpiry = Date.parse(user?.free_expires_at || '') || 0;
      const legacyExpiry = Date.parse(row.expires_at || '') || 0;
      db.prepare('UPDATE users SET user_level=?,free_expires_at=?,updated_at=? WHERE id=?')
        .run(level, legacyExpiry > currentExpiry ? row.expires_at : user?.free_expires_at, nowIso(), row.user_id);
    }
    db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('account_user_level_migration_v1','1',?)
      ON CONFLICT(key) DO UPDATE SET value='1',updated_at=excluded.updated_at`).run(nowIso());
  }""")

replace(account, "  function sessionDays() { return getIntSetting('account_session_days', 30, 1, 365); }", """  function normalLevelConfig() {
    const free = freeConfig();
    return {
      code: 'normal', name: '普通用户', priceCents: 0, originalPriceCents: 0, promoPriceCents: null,
      promoEndsAt: null, promoActive: false, savingsCents: 0, durationDays: free.days,
      limits: { devices: free.maxDevices, windows: free.maxWindows },
      benefits: [`${free.maxDevices} 台设备`, `最多 ${free.maxWindows} 个同时窗口`, '完整 GPTWork 功能'],
      enabled: true, sortOrder: 10,
    };
  }
  function planLevelPublic(row) {
    if (!row) return null;
    let benefits = [];
    try { benefits = JSON.parse(row.benefits_json || '[]'); } catch {}
    return {
      code: row.code, name: row.name, ...normalizePlanPricing(row), durationDays: row.duration_days,
      limits: { devices: row.max_devices, windows: row.max_windows }, benefits,
      enabled: Boolean(row.enabled), sortOrder: row.sort_order,
    };
  }
  function levelDefinitions({ publicOnly = false } = {}) {
    const paid = db.prepare(\"SELECT * FROM membership_plans WHERE code IN ('deep','heavy') ORDER BY sort_order,code\").all()
      .filter((row) => !publicOnly || row.enabled).map(planLevelPublic);
    return [normalLevelConfig(), ...paid];
  }
  function userLevelCode(user) {
    const value = String(user?.user_level || 'normal').toLowerCase();
    return USER_LEVEL_CODES.has(value) ? value : 'normal';
  }
  function userLevel(user) {
    const code = userLevelCode(user);
    return levelDefinitions().find((item) => item.code === code) || normalLevelConfig();
  }
  function sessionDays() { return getIntSetting('account_session_days', 30, 1, 365); }""")

sub(account, r"  function entitlementFor\(user\) \{.*?\n  \}\n  function membershipPublic", """  function entitlementFor(user) {
    const level = userLevel(user);
    let active = false;
    const expiresAt = user?.free_expires_at || null;
    let maxDevices = level.limits.devices;
    let maxWindows = level.limits.windows;
    if (user && user.status === 'active' && emailAccessSatisfied(user)
        && user.free_expires_at && Date.parse(user.free_expires_at) > Date.now()) {
      active = true;
    }
    if (user?.max_devices_override !== null && user?.max_devices_override !== undefined) maxDevices = user.max_devices_override;
    if (user?.max_windows_override !== null && user?.max_windows_override !== undefined) maxWindows = user.max_windows_override;
    purgeWindowLeases();
    const usageDevices = user ? db.prepare('SELECT COUNT(*) AS count FROM user_devices WHERE user_id=?').get(user.id).count : 0;
    const usageWindows = user ? db.prepare(`SELECT COUNT(*) AS count FROM user_window_leases wl
      JOIN user_sessions s ON s.id=wl.session_id WHERE s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>?`).get(user.id, nowIso()).count : 0;
    return {
      active,
      source: 'level',
      expiresAt,
      level: { code: level.code, name: level.name, rank: USER_LEVEL_RANK[level.code] ?? 0 },
      limits: { devices: maxDevices, windows: maxWindows },
      usage: { devices: usageDevices, windows: usageWindows },
    };
  }
  function membershipPublic""")

sub(account, r"  function accountSummary\(user, session = null\) \{.*?\n  \}\n\n  function sessionFromToken", """  function accountSummary(user, session = null) {
    if (!user) return { authenticated: false };
    const entitlement = entitlementFor(user);
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
      level: entitlement.level,
      // Legacy fields are kept for old clients/order history only. New clients use level.
      membership: membershipPublic(currentMembership(user.id)),
      nextMembership: membershipPublic(nextMembership(user.id)),
      entitlement,
      session: session ? { expiresAt: session.expires_at, deviceId: session.device_id } : null,
    };
  }

  function sessionFromToken""")
replace(account, "u.email,u.password_hash,u.status AS user_status,u.email_verified_at,u.email_verification_exempt,u.free_expires_at,\n      u.max_devices_override", "u.email,u.password_hash,u.status AS user_status,u.email_verified_at,u.email_verification_exempt,u.free_expires_at,u.user_level,\n      u.max_devices_override")
replace(account, "      free_expires_at: row.free_expires_at,\n      max_devices_override", "      free_expires_at: row.free_expires_at,\n      user_level: row.user_level,\n      max_devices_override")

sub(account, r"  function publicPlans\(\) \{.*?\n  \}\n  function publicPaymentMethods", """  function publicPlans() {
    return levelDefinitions({ publicOnly: true }).filter((level) => level.code !== 'normal');
  }
  function publicPaymentMethods""")

sub(account, r"  function grantMembership\(userId, planCode, source = 'admin', orderId = null, frozenTerms = null\) \{.*?\n  \}\n\n  function orderPublic", """  function grantMembership(userId, planCode, source = 'admin', orderId = null, frozenTerms = null) {
    const plan = db.prepare(\"SELECT * FROM membership_plans WHERE code IN ('deep','heavy') AND code=?\").get(String(planCode || ''));
    if (!plan) fail(404, 'PLAN_NOT_FOUND', '升级等级不存在');
    const terms = normalizePlanSnapshot(frozenTerms, plan);
    if (terms.code !== plan.code) fail(409, 'PLAN_SNAPSHOT_MISMATCH', '订单等级快照与升级等级不匹配');
    const user = userById(userId);
    const latest = db.prepare(`SELECT expires_at FROM memberships WHERE user_id=? AND status='active' ORDER BY expires_at DESC LIMIT 1`).get(userId);
    const baseMs = Math.max(Date.now(), Date.parse(user?.free_expires_at || '') || 0, Date.parse(latest?.expires_at || '') || 0);
    const startsAt = new Date(baseMs).toISOString();
    const expiresAt = new Date(baseMs + terms.durationDays * DAY_MS).toISOString();
    const result = db.prepare(`INSERT INTO memberships(user_id,plan_code,starts_at,expires_at,status,source,order_id,plan_snapshot_json,created_at) VALUES(?,?,?,?, 'active',?,?,?,?)`)
      .run(userId, plan.code, startsAt, expiresAt, source, orderId, JSON.stringify(terms), nowIso());
    db.prepare('UPDATE users SET user_level=?,free_expires_at=?,updated_at=? WHERE id=?')
      .run(plan.code, expiresAt, nowIso(), userId);
    audit('level_upgraded', userId, { membershipId: Number(result.lastInsertRowid), level: plan.code, startsAt, expiresAt, source });
    return hydrateMembership(db.prepare(`${MEMBERSHIP_SELECT} WHERE m.id=?`).get(Number(result.lastInsertRowid)));
  }

  function orderPublic""")

# Reward helpers shared by extension API. Website endpoints keep their cookie-facing compatibility layer.
replace(account, "  async function handleApi(req, res, url, cors = {}) {", """  function rewardDayKey(at = Date.now()) {
    return new Date(at + REWARD_TIMEZONE_OFFSET_MS).toISOString().slice(0, 10);
  }
  function ensureShareCode(userId) {
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
    fail(500, 'SHARE_CODE_UNAVAILABLE', '暂时无法生成分享链接，请稍后重试');
  }
  function extendRewardDays(userId, days) {
    const rewardDays = clampInt(days, 1, 3650, 1);
    const user = userById(userId);
    if (!user) fail(404, 'ACCOUNT_NOT_FOUND', '账户不存在');
    const baseMs = Math.max(Date.now(), Date.parse(user.free_expires_at || '') || 0);
    const expiresAt = new Date(baseMs + rewardDays * DAY_MS).toISOString();
    db.prepare('UPDATE users SET free_expires_at=?,updated_at=? WHERE id=?').run(expiresAt, nowIso(), userId);
    return expiresAt;
  }
  function rewardSnapshot(userId) {
    const code = ensureShareCode(userId);
    const checked = db.prepare('SELECT created_at FROM account_daily_checkins WHERE user_id=? AND day_key=?').get(userId, rewardDayKey());
    const checkins = db.prepare('SELECT COUNT(*) AS count FROM account_daily_checkins WHERE user_id=?').get(userId);
    const shares = db.prepare('SELECT COUNT(*) AS count FROM account_invites WHERE inviter_user_id=?').get(userId);
    const user = userById(userId);
    return {
      checkin: { checkedInToday: Boolean(checked), checkedInAt: checked?.created_at || null, rewardDays: CHECKIN_REWARD_DAYS, totalCheckins: Number(checkins?.count || 0) },
      share: {
        code,
        url: `${String(publicOrigin || '').replace(/\\/$/, '')}/account?invite=${encodeURIComponent(code)}`,
        rewardDays: SHARE_REWARD_DAYS,
        successfulShares: Number(shares?.count || 0),
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
    audit('daily_checkin', userId, { rewardDays: CHECKIN_REWARD_DAYS });
    return { alreadyCheckedIn: false, rewards: rewardSnapshot(userId) };
  }

  async function handleApi(req, res, url, cors = {}) {""")
replace(account, "          free: freeConfig(),\n          plans: publicPlans(),", "          free: freeConfig(),\n          levels: levelDefinitions({ publicOnly: true }),\n          plans: publicPlans(),")

replace(account, "      if (path === '/api/v1/account/logout' && req.method === 'POST') {", """      if (path === '/api/v1/account/rewards' && req.method === 'GET') {
        const session = requireSession(req);
        return json(res, 200, { ok: true, rewards: rewardSnapshot(session.user_id) }, cors), true;
      }

      if (path === '/api/v1/account/checkin' && req.method === 'POST') {
        const session = requireSession(req);
        const result = checkIn(session.user_id);
        return json(res, 200, { ok: true, ...result, account: accountSummary(userById(session.user_id), session) }, cors), true;
      }

      if (path === '/api/v1/account/logout' && req.method === 'POST') {""")

sub(account, r"        purgeWindowLeases\(\);\n        // Window leases are telemetry/liveness records only\..*?\n        const account = accountSummary", """        purgeWindowLeases();
        const now = nowIso();
        db.prepare('DELETE FROM user_window_leases WHERE session_id=?').run(session.id);
        const occupiedByOtherSessions = Number(db.prepare(`SELECT COUNT(*) AS count FROM user_window_leases wl
          JOIN user_sessions s ON s.id=wl.session_id
          WHERE s.user_id=? AND s.id<>? AND s.revoked_at IS NULL AND s.expires_at>?`)
          .get(session.user_id, session.id, now).count || 0);
        const remaining = Math.max(0, Number(entitlement.limits.windows || 1) - occupiedByOtherSessions);
        const allowed = entitlement.active ? requested.slice(0, remaining) : [];
        const insert = db.prepare('INSERT INTO user_window_leases(session_id,window_key,first_seen_at,last_seen_at) VALUES(?,?,?,?)');
        for (const key of allowed) insert.run(session.id, key, now, now);
        db.prepare('UPDATE user_sessions SET last_seen_at=?,extension_version=? WHERE id=?')
          .run(now, String(input.extensionVersion || session.extension_version).slice(0, 40), session.id);
        db.prepare('UPDATE user_devices SET last_seen_at=? WHERE user_id=? AND device_id=?').run(now, session.user_id, session.device_id);
        const account = accountSummary""", count=1)

replace(account, "      membership: membershipPublic(membership),\n      entitlement,", "      membership: membershipPublic(membership),\n      level: entitlement.level,\n      entitlement,")

# Admin plan endpoint exposes normal/deep/heavy as user levels.
sub(account, r"      if \(path === '/admin/api/account/plans' && req.method === 'GET'\) \{.*?\n      \}\n      const planMatch", """      if (path === '/admin/api/account/plans' && req.method === 'GET') {
        return json(res, 200, { ok: true, plans: levelDefinitions() }), true;
      }
      const planMatch""")
replace(account, "      if (planMatch && req.method === 'PUT') {\n        const plan = db.prepare('SELECT * FROM membership_plans WHERE code=?').get(planMatch[1]);", """      if (planMatch && req.method === 'PUT') {
        const input = await bodyJson(req);
        if (planMatch[1] === 'normal') {
          const current = freeConfig();
          setSetting('account_free_days', clampInt(input.durationDays, 0, 3650, current.days));
          setSetting('account_free_max_devices', clampInt(input.maxDevices, 1, 1000, current.maxDevices));
          setSetting('account_free_max_windows', clampInt(input.maxWindows, 1, 1000, current.maxWindows));
          audit('admin_level_updated', null, { level: 'normal', ...freeConfig() });
          return json(res, 200, { ok: true }), true;
        }
        const plan = db.prepare(\"SELECT * FROM membership_plans WHERE code IN ('deep','heavy') AND code=?\").get(planMatch[1]);""")
replace(account, "        const input = await bodyJson(req);\n        const name = String(input.name || plan.name).slice(0, 120);", "        const name = String(input.name || plan.name).slice(0, 120);")
replace(account, "if (!plan) fail(404, 'PLAN_NOT_FOUND', '会员套餐不存在');", "if (!plan) fail(404, 'PLAN_NOT_FOUND', '用户等级不存在');")

# Admin user patch accepts direct level configuration.
replace(account, "        const status = ['active', 'disabled', 'pending'].includes(input.status) ? input.status : user.status;", """        const status = ['active', 'disabled', 'pending'].includes(input.status) ? input.status : user.status;
        const requestedLevel = input.userLevel === undefined ? userLevelCode(user) : String(input.userLevel || '').toLowerCase();
        if (!USER_LEVEL_CODES.has(requestedLevel)) fail(400, 'INVALID_USER_LEVEL', '用户等级必须是普通、深度或重度');""")
replace(account, "          db.prepare(`UPDATE users SET email=?,status=?,free_expires_at=?,max_devices_override=?,max_windows_override=?,updated_at=? WHERE id=?`)\n            .run(email, status, freeExpiresAt, maxDevicesOverride, maxWindowsOverride, changedAt, user.id);", """          db.prepare(`UPDATE users SET email=?,status=?,free_expires_at=?,user_level=?,max_devices_override=?,max_windows_override=?,updated_at=? WHERE id=?`)
            .run(email, status, freeExpiresAt, requestedLevel, maxDevicesOverride, maxWindowsOverride, changedAt, user.id);""")
replace(account, "          emailChanged: email !== user.email, status, freeExpiresAt, membershipId: membership?.id || null,", "          emailChanged: email !== user.email, status, userLevel: requestedLevel, freeExpiresAt, membershipId: membership?.id || null,")

# ---- Background: enforce the server-approved per-window lease list. ----
background = 'extension/background.js'
replace(background, """function accountAllowsState(_state) {
  // Account entitlement controls access, but the number of Chrome windows never does.
  // Window keys remain heartbeat telemetry only and must not disable GPTWork.
  return Boolean(accountState?.authenticated && accountState?.entitlement?.active);
}""", """function accountAllowsState(state) {
  if (!accountState?.authenticated || !accountState?.entitlement?.active) return false;
  const windowKey = Number.isInteger(state?.windowId) ? `chrome:${state.windowId}` : null;
  if (!windowKey) return true;
  const allowed = Array.isArray(accountState.allowedWindowKeys) ? accountState.allowedWindowKeys : [];
  const denied = Array.isArray(accountState.deniedWindowKeys) ? accountState.deniedWindowKeys : [];
  if (!allowed.length && !denied.length) return true;
  return allowed.includes(windowKey) && !denied.includes(windowKey);
}""")

# ---- Popup: level naming, true window usage, check-in/share controls, and upgrade entry. ----
popup = 'extension/popup.html'
replace(popup, '<div><strong id="accountEmail">—</strong><p id="accountTier">正在读取账户…</p></div>', '<div><strong id="accountEmail">—</strong><div class="account-tier-row"><p id="accountTier">正在读取账户…</p><button id="accountUpgrade" class="account-upgrade" type="button">升级</button></div></div>')
replace(popup, '<div class="account-meta">\n          <span id="accountExpiry">有效期 —</span>\n          <span id="accountUsage">设备/窗口 —</span>\n        </div>', '<div class="account-meta"><div class="account-expiry-row"><span id="accountExpiry">有效期 —</span><div class="reward-actions"><button id="accountCheckin" class="reward-button" type="button">签到<sup>+1</sup></button><button id="accountShare" class="reward-button" type="button">分享<sup>+7</sup></button></div></div><span id="accountUsage">设备/窗口 —</span></div>')
replace(popup, '<script type="module" src="auth-gate.js"></script>', '<script type="module" src="auth-gate.js"></script>\n<script type="module" src="popup-rewards.js"></script>')

css = 'extension/popup.css'
text = read(css)
text += """
.account-tier-row{display:flex;align-items:center;gap:7px}.account-tier-row p{margin:2px 0 0}.account-upgrade{border:0;background:transparent!important;color:#dc2626!important;padding:0!important;font-size:9px;font-weight:900}.account-meta{display:grid!important;gap:5px!important}.account-expiry-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.reward-actions{display:flex;gap:5px}.reward-button{position:relative;padding:4px 10px!important;border:1px solid #dbe3ef!important;background:#fff!important;color:#1d4ed8!important;border-radius:8px!important;font-size:9px!important;overflow:visible!important}.reward-button sup{position:absolute;right:-3px;top:-7px;color:#dc2626;font-size:8px;font-weight:900;background:#fff;border-radius:999px;padding:0 2px}.reward-button:disabled{color:#64748b!important}.reward-button:disabled sup{color:#94a3b8}
"""
write(css, text)

auth = 'extension/auth-gate.js'
replace(auth, "  accountEmail: $('accountEmail'), accountTier: $('accountTier'), accountExpiry: $('accountExpiry'), accountUsage: $('accountUsage'), accountCenter: $('accountCenter'), accountLogout: $('accountLogout'),", "  accountEmail: $('accountEmail'), accountTier: $('accountTier'), accountExpiry: $('accountExpiry'), accountUsage: $('accountUsage'), accountCenter: $('accountCenter'), accountLogout: $('accountLogout'), accountUpgrade: $('accountUpgrade'),")
replace(auth, "  const membership = account.membership;\n  const sourceName = membership?.name || (entitlement.source === 'free' ? '免费期 / Free' : '无有效权益');", "  const sourceName = account.level?.name || entitlement.level?.name || '普通用户';")
replace(auth, "  el.accountUsage.textContent = `设备 ${usage.devices ?? 0}/${limits.devices ?? 0} · 窗口不限`;", "  el.accountUsage.textContent = `设备 ${usage.devices ?? 0}/${limits.devices ?? 0} · 窗口 ${usage.windows ?? 0}/${limits.windows ?? 0}`;")
replace(auth, "    if (!entitlement.active) el.enabled.title = '免费期或会员已到期，请在账户中心开通会员';\n    else el.enabled.title = '启用或关闭 GPTWork；窗口数量不受限制';", "    if (!entitlement.active) el.enabled.title = '当前使用时长已到期，请签到、分享或升级用户等级';\n    else el.enabled.title = `启用或关闭 GPTWork；当前等级最多 ${limits.windows ?? 1} 个同时窗口`;")
replace(auth, "el.accountCenter?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('account.html') }));", "el.accountCenter?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('account.html') }));\nel.accountUpgrade?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('account.html#upgrade') }));")

# New popup reward module talks directly to the authenticated account API using the local session token.
popup_rewards = '''const API_BASE = 'https://gptlock.mv3.cn';
const SESSION_KEY = 'gptlockAccountSessionToken';
const checkin = document.getElementById('accountCheckin');
const share = document.getElementById('accountShare');

async function token() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  return typeof stored[SESSION_KEY] === 'string' ? stored[SESSION_KEY] : '';
}
async function request(path, options = {}) {
  const session = await token();
  if (!session) throw new Error('请先登录');
  const response = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store', credentials: 'omit', ...options,
    headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error?.message || `HTTP ${response.status}`);
  return data;
}
function apply(rewards) {
  if (!checkin) return;
  const done = Boolean(rewards?.checkin?.checkedInToday);
  checkin.disabled = done;
  checkin.firstChild && (checkin.firstChild.textContent = done ? '已签到' : '签到');
  checkin.title = done ? '今天已签到，明天可再次领取 +1 天' : '每日签到增加 1 天使用时长';
  if (share) share.title = '复制分享链接；成功分享并带来 1 个已验证账户后增加 7 天使用时长';
}
async function refresh() {
  try { apply((await request('/api/v1/account/rewards')).rewards); } catch {}
}
checkin?.addEventListener('click', async () => {
  checkin.disabled = true;
  try {
    const data = await request('/api/v1/account/checkin', { method: 'POST', body: '{}' });
    apply(data.rewards);
    chrome.runtime.sendMessage({ type: 'GPTLOCK_ACCOUNT_REFRESH' }, () => void chrome.runtime.lastError);
    document.dispatchEvent(new CustomEvent('gptwork-account-changed'));
  } catch (error) {
    checkin.disabled = false;
    checkin.title = `签到失败：${error.message}`;
  }
});
share?.addEventListener('click', async () => {
  const original = share.firstChild?.textContent || '分享';
  try {
    const rewards = (await request('/api/v1/account/rewards')).rewards;
    const url = rewards?.share?.url || '';
    if (!url) throw new Error('分享链接暂不可用');
    await navigator.clipboard.writeText(url);
    if (share.firstChild) share.firstChild.textContent = '已复制';
    share.title = '分享链接已复制；对方完成注册/验证后，你将获得 +7 天';
    setTimeout(() => { if (share.firstChild) share.firstChild.textContent = original; }, 1200);
  } catch (error) { share.title = `分享失败：${error.message}`; }
});
document.addEventListener('gptwork-account-changed', () => void refresh());
void refresh();
'''
write('extension/popup-rewards.js', popup_rewards)

# ---- Extension account center: user level + upgrade dialog. ----
ext_html = 'extension/account.html'
replace(ext_html, '<div class="hero-right"><strong id="tier">—</strong><span id="expiry">—</span></div>', '<div class="hero-right"><div class="level-line"><span class="muted">用户等级</span><strong id="tier">—</strong><button id="upgradeButton" class="upgrade-link" type="button">升级</button></div><span id="expiry">—</span></div>')
replace(ext_html, '<section class="stats">\n      <article class="card"><span>设备</span><strong id="deviceUsage">—</strong></article>\n      <article class="card"><span>免费期限</span><strong id="freeExpiry">—</strong></article>\n      <article class="card"><span>会员期限</span><strong id="memberExpiry">—</strong></article>\n    </section>', '<section class="stats"><article class="card"><span>设备</span><strong id="deviceUsage">—</strong></article><article class="card"><span>窗口</span><strong id="windowUsage">—</strong></article><article class="card"><span>有效期</span><strong id="levelExpiry">—</strong></article></section>')
# Keep legacy hidden surface for compatibility tests/CMS, but add a first-class upgrade dialog.
replace(ext_html, '    <section class="card" id="membershipPlansSection" hidden aria-hidden="true">', '    <dialog id="upgradeDialog" class="upgrade-dialog"><div class="upgrade-dialog-head"><div><h2>升级用户等级</h2><p class="muted">普通用户可升级为深度或重度用户；价格、有效期、设备和窗口权益以服务端配置为准。</p></div><button id="upgradeClose" type="button" aria-label="关闭">×</button></div><div id="plans" class="plans"></div><p id="orderMessage" class="message"></p></dialog>\n\n    <section class="card" id="membershipPlansSection" hidden aria-hidden="true">')
# Remove duplicate IDs from the legacy hidden block so only dialog owns plans/orderMessage.
replace(ext_html, '      <div id="plans" class="plans"></div>\n      <p id="orderMessage" class="message"></p>', '      <div class="plans-legacy-placeholder"></div>\n      <p class="message"></p>')

ext_css = 'extension/account.css'
text = read(ext_css)
text += ".level-line{display:flex;align-items:center;gap:8px}.upgrade-link{border:0;background:transparent;color:#dc2626;padding:0;font-size:13px;font-weight:900}.upgrade-dialog{width:min(920px,92vw);max-height:86vh;border:0;border-radius:20px;padding:20px;box-shadow:0 28px 90px rgba(15,23,42,.28)}.upgrade-dialog::backdrop{background:rgba(15,23,42,.55)}.upgrade-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}.upgrade-dialog-head h2{margin-bottom:4px}.upgrade-dialog-head>button{border:0;background:transparent;font-size:28px;padding:0 6px}.plan-current{outline:2px solid #bfdbfe}.plan-unavailable{opacity:.62}.stats{grid-template-columns:repeat(3,1fr)!important}\n"
write(ext_css, text)

ext_js = 'extension/account.js'
replace(ext_js, "  deviceUsage: $('deviceUsage'), freeExpiry: $('freeExpiry'), memberExpiry: $('memberExpiry'), plans: $('plans'), orderMessage: $('orderMessage'),", "  deviceUsage: $('deviceUsage'), windowUsage: $('windowUsage'), levelExpiry: $('levelExpiry'), plans: $('plans'), orderMessage: $('orderMessage'), upgradeButton: $('upgradeButton'), upgradeDialog: $('upgradeDialog'), upgradeClose: $('upgradeClose'),")
sub(ext_js, r"function renderPlans\(\) \{.*?\n\}\n\nfunction renderSecurity", """function renderPlans() {
  el.plans.textContent = '';
  const methods = Array.isArray(config?.paymentMethods) ? config.paymentMethods : [];
  const currentRank = Number(account?.level?.rank ?? account?.entitlement?.level?.rank ?? 0);
  const plans = (config?.plans || []).filter((plan) => ({ deep: 1, heavy: 2 }[plan.code] ?? 0) > currentRank);
  if (!plans.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '当前已经是最高用户等级。'; el.plans.append(empty); return;
  }
  for (const plan of plans) {
    const card = document.createElement('article'); card.className = 'plan';
    const title = document.createElement('h3'); title.textContent = plan.name;
    const price = document.createElement('div'); price.className = 'price'; price.textContent = money(plan.priceCents);
    const small = document.createElement('small'); small.textContent = ` / ${plan.durationDays} 天`; price.append(small);
    const benefits = document.createElement('ul'); benefits.className = 'benefits';
    for (const item of plan.benefits || []) { const li = document.createElement('li'); li.textContent = item; benefits.append(li); }
    const limit = document.createElement('p'); limit.className = 'muted'; limit.textContent = `设备 ${plan.limits.devices} · 同时窗口 ${plan.limits.windows}`;
    const payRow = document.createElement('div'); payRow.className = 'pay-row';
    if (!methods.length) {
      const disabled = document.createElement('button'); disabled.disabled = true; disabled.textContent = '支付方式暂未配置'; payRow.append(disabled);
    } else {
      for (const method of methods) {
        const button = document.createElement('button'); button.className = 'primary'; button.textContent = `${method.name}升级`;
        button.addEventListener('click', () => void createOrder(plan, method, button)); payRow.append(button);
      }
    }
    card.append(title, price, limit, benefits, payRow); el.plans.append(card);
  }
}

function renderSecurity""")
replace(ext_js, "  el.tier.textContent = account.membership?.name || (entitlement.source === 'free' ? '免费期 / Free' : '未开通会员');", "  el.tier.textContent = account.level?.name || entitlement.level?.name || '普通用户';")
replace(ext_js, "  el.deviceUsage.textContent = `${entitlement.usage?.devices ?? 0} / ${entitlement.limits?.devices ?? 0}`;\n  el.freeExpiry.textContent = localDate(user.freeExpiresAt);\n  el.memberExpiry.textContent = localDate(account.membership?.expiresAt);", "  el.deviceUsage.textContent = `${entitlement.usage?.devices ?? 0} / ${entitlement.limits?.devices ?? 0}`;\n  el.windowUsage.textContent = `${entitlement.usage?.windows ?? 0} / ${entitlement.limits?.windows ?? 0}`;\n  el.levelExpiry.textContent = localDate(entitlement.expiresAt);")
replace(ext_js, "el.refresh.addEventListener('click', () => void load());\nvoid load();", """el.upgradeButton?.addEventListener('click', () => { renderPlans(); el.upgradeDialog?.showModal(); });
el.upgradeClose?.addEventListener('click', () => el.upgradeDialog?.close());
el.upgradeDialog?.addEventListener('click', (event) => { if (event.target === el.upgradeDialog) el.upgradeDialog.close(); });
el.refresh.addEventListener('click', () => void load());
void load().then(() => { if (location.hash === '#upgrade' && account?.authenticated) { renderPlans(); el.upgradeDialog?.showModal(); } });""")

# Commerce copy: membership terminology is removed from the visible extension flow.
commerce = 'extension/account-commerce.js'
text = read(commerce)
text = text.replace("'会员开通'", "'等级升级'").replace("'支付成功 · 已开通'", "'支付成功 · 已升级'")
text = text.replace('支付成功，会员权益已自动开通。正在刷新…', '支付成功，用户等级权益已自动升级。正在刷新…')
text = text.replace("'会员'", "'用户等级'")
write(commerce, text)

# ---- Admin: rename Membership to User Configuration and expose 3 level cards. ----
for p in (ROOT / 'license-server/public').glob('admin-*.html'):
    text = p.read_text(encoding='utf-8')
    text = text.replace('>会员</a>', '>用户配置</a>')
    p.write_text(text, encoding='utf-8')
admin_plans = 'license-server/public/admin-plans.html'
text = read(admin_plans)
text = text.replace('<title>GPTWork 管理 · 会员</title>', '<title>GPTWork 管理 · 用户配置</title>')
text = text.replace('<h1>会员</h1>', '<h1>用户配置</h1>')
text = text.replace('<h2>会员套餐</h2><p class="muted">月卡、季卡、年卡的价格、期限与设备权益可在线调整；同时窗口不限。</p>', '<h2>用户等级</h2><p class="muted">新用户注册后默认普通用户。这里可设置新用户初始有效天数，以及普通、深度、重度用户的设备/窗口权益和深度、重度升级价格。</p>')
write(admin_plans, text)

adminjs = 'license-server/public/admin.js'
sub(adminjs, r"function planCard\(plan\) \{.*?\n\}\n\nfunction renderPlans", """function planCard(plan) {
  const card = document.createElement('article'); card.className = 'plan-card';
  const isNormal = plan.code === 'normal';
  const head = document.createElement('div'); head.className = 'plan-head';
  const title = document.createElement('div');
  const name = document.createElement('input'); name.value = plan.name; name.readOnly = isNormal; name.setAttribute('aria-label', '用户等级名称');
  const code = document.createElement('small'); code.textContent = plan.code;
  title.append(name, code); head.append(title);
  const grid = document.createElement('div'); grid.className = 'plan-fields';
  const makeField = (labelText, value, min = 0) => {
    const label = document.createElement('label'); label.textContent = labelText;
    const input = document.createElement('input'); input.type = 'number'; input.min = String(min); input.value = String(value ?? '');
    label.append(input); grid.append(label); return input;
  };
  let originalPrice = null; let promoPrice = null; let promoEnd = null; let enabled = { checked: true };
  if (!isNormal) {
    originalPrice = makeField('升级价格（元）', ((plan.originalPriceCents ?? plan.priceCents) / 100).toFixed(2), 0); originalPrice.step = '0.01';
    promoPrice = makeField('促销价（元，可选）', plan.promoPriceCents == null ? '' : (plan.promoPriceCents / 100).toFixed(2), 0); promoPrice.step = '0.01';
    const promoEndLabel = document.createElement('label'); promoEndLabel.textContent = '促销结束时间（可选）';
    promoEnd = document.createElement('input'); promoEnd.type = 'datetime-local'; promoEnd.value = localDateInput(plan.promoEndsAt); promoEndLabel.append(promoEnd); grid.append(promoEndLabel);
    const enabledLabel = document.createElement('label'); enabledLabel.className = 'check compact'; enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(plan.enabled); enabledLabel.append(enabled, document.createTextNode(' 允许付费升级')); head.append(enabledLabel);
  }
  const days = makeField(isNormal ? '新用户初始有效天数' : '升级后有效天数', plan.durationDays, isNormal ? 0 : 1);
  const devices = makeField('设备上限', plan.limits.devices, 1);
  const windows = makeField('同时窗口上限', plan.limits.windows, 1);
  const benefitsLabel = document.createElement('label'); benefitsLabel.className = 'benefit-field'; benefitsLabel.textContent = '权益说明（每行一条）';
  const benefits = document.createElement('textarea'); benefits.rows = 5; benefits.value = (plan.benefits || []).join('\\n'); benefits.disabled = isNormal; benefitsLabel.append(benefits);
  const save = button('保存等级配置', async () => {
    save.disabled = true;
    try {
      const originalPriceCents = isNormal ? 0 : Math.round(Number(originalPrice.value) * 100);
      const promoPriceCents = isNormal || promoPrice.value.trim() === '' ? null : Math.round(Number(promoPrice.value) * 100);
      const promoEndsAt = isNormal || !promoEnd.value ? null : new Date(promoEnd.value).toISOString();
      if (!Number.isInteger(originalPriceCents) || originalPriceCents < 0) throw new Error('升级价格格式无效');
      if (promoPriceCents !== null && (!Number.isInteger(promoPriceCents) || promoPriceCents < 0 || promoPriceCents >= originalPriceCents)) throw new Error('促销价必须低于升级价格');
      await api(`/admin/api/account/plans/${encodeURIComponent(plan.code)}`, {
        method: 'PUT', body: JSON.stringify({
          name: name.value.trim(), priceCents: originalPriceCents, originalPriceCents, promoPriceCents, promoEndsAt,
          durationDays: Number(days.value), maxDevices: Number(devices.value), maxWindows: Number(windows.value),
          benefits: benefits.value.split(/\\r?\\n/).map((item) => item.trim()).filter(Boolean), enabled: enabled.checked,
        }),
      });
      save.textContent = '已保存'; setTimeout(() => { save.textContent = '保存等级配置'; }, 1000); await loadPlans();
    } catch (error) { alert(error.message); } finally { save.disabled = false; }
  }, 'primary');
  card.append(head, grid, benefitsLabel, save); return card;
}

function renderPlans""")

admin_users_html = 'license-server/public/admin-users.html'
text = read(admin_users_html)
text = text.replace('查看账户权益、客户端版本、在线设备和同步状态', '查看用户等级、客户端版本、在线设备和同步状态')
text = text.replace('<label>免费天数<input id="createUserFreeDays"', '<label>新用户初始有效天数<input id="createUserFreeDays"')
text = text.replace('留空=跟随默认/套餐', '留空=跟随用户等级')
text = text.replace('<th>权益 / 套餐</th>', '<th>用户等级</th>')
write(admin_users_html, text)

admin_users_js = 'license-server/public/admin-users.js'
sub(admin_users_js, r"function accountTier\(row\) \{.*?\n\}", """function accountTier(row) {
  return row.level?.name || row.entitlement?.level?.name || '普通用户';
}""")
replace(admin_users_js, "el.userEditTitle.textContent = ({ email: '编辑邮箱', status: '设置账户状态', devices: '设置设备上限', entitlement: '设置权益 / 套餐' })[kind] || '编辑用户';", "el.userEditTitle.textContent = ({ email: '编辑邮箱', status: '设置账户状态', devices: '设置设备上限', entitlement: '设置用户等级' })[kind] || '编辑用户';")
sub(admin_users_js, r"  \} else if \(kind === 'entitlement'\) \{.*?\n  \}\n  el.userEditDialog.showModal", """  } else if (kind === 'entitlement') {
    const levels = plansCache.filter((item) => ['normal','deep','heavy'].includes(item.code));
    const level = selectControl(levels.map((item) => [item.code, item.name]), row.level?.code || row.entitlement?.level?.code || 'normal');
    const expiry = document.createElement('input'); expiry.type = 'datetime-local'; expiry.value = localDateInput(row.entitlement?.expiresAt);
    activeEditor.controls.level = level; activeEditor.controls.expiry = expiry;
    el.userEditBody.append(field('用户等级', level), field('使用有效期', expiry));
    const note = document.createElement('p'); note.className = 'dialog-note';
    note.textContent = '等级决定设备/窗口上限；有效期决定当前账号还能使用多久。管理员可直接调整等级，不会创建会员套餐。';
    el.userEditBody.append(note);
  }
  el.userEditDialog.showModal""")
sub(admin_users_js, r"  \} else if \(kind === 'entitlement'\) \{.*?\n  \}\n  closeEditor\(\);", """  } else if (kind === 'entitlement') {
    const expiry = controls.expiry.value ? new Date(controls.expiry.value) : null;
    if (expiry && Number.isNaN(expiry.getTime())) throw new Error('有效期格式无效');
    await patchUser(row, { userLevel: controls.level.value, entitlementExpiresAt: expiry ? expiry.toISOString() : null });
  }
  closeEditor();""")
replace(admin_users_js, "entitlementCell.append(tier, iconButton('⚙', `设置 ${row.email} 的权益 / 套餐`, () => openEditor(row, 'entitlement')), remaining);", "entitlementCell.append(tier, iconButton('⚙', `设置 ${row.email} 的用户等级`, () => openEditor(row, 'entitlement')), remaining);")

# ---- Public account center: rename invite -> share in visible copy, keep route/IDs for compatibility. ----
web_account = 'license-server/public/account.html'
text = read(web_account)
text = text.replace('签到与邀请奖励', '签到与分享奖励').replace('成功邀请 1 人 +7 天', '成功分享并带来 1 人 +7 天')
text = text.replace('GPTWork 邀请链接', 'GPTWork 分享链接').replace('邀请关系会自动确认', '分享关系会自动确认')
text = text.replace('当前权益</span>', '用户等级</span>')
text = text.replace('签到与邀请</h3>', '签到与分享</h3>').replace('每成功邀请 1 个已验证账户增加 7 天', '每成功分享并带来 1 个已验证账户增加 7 天')
text = text.replace('成功邀请</span>', '成功分享</span>').replace('我的邀请码', '我的分享码').replace('邀请链接', '分享链接').replace('复制邀请链接', '复制分享链接')
write(web_account, text)

rewards = 'license-server/public/account-rewards.js'
text = read(rewards)
text = text.replace('邀请关系此前已经确认', '分享关系此前已经确认').replace('邀请关系已确认，邀请人已获得 7 天使用时长。', '分享关系已确认，分享人已获得 7 天使用时长。')
text = text.replace('邀请码处理失败', '分享码处理失败').replace('邀请链接已复制。对方注册并登录该链接后，你将获得 7 天使用时长。', '分享链接已复制。对方注册并登录该链接后，你将获得 7 天使用时长。')
text = text.replace('请复制已选中的邀请链接。', '请复制已选中的分享链接。')
write(rewards, text)

# Static regression coverage for the migration surface.
test = '''import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const account = readFileSync(join(ROOT, 'license-server/account-system.mjs'), 'utf8');
const popup = readFileSync(join(ROOT, 'extension/popup.html'), 'utf8');
const rewards = readFileSync(join(ROOT, 'extension/popup-rewards.js'), 'utf8');
const background = readFileSync(join(ROOT, 'extension/background.js'), 'utf8');
const plans = readFileSync(join(ROOT, 'license-server/public/admin-plans.html'), 'utf8');
const users = readFileSync(join(ROOT, 'license-server/public/admin-users.html'), 'utf8');

test('user levels replace public membership semantics and enforce requested defaults', () => {
  assert.match(account, /code: 'deep'.*?maxDevices: 1, maxWindows: 3/s);
  assert.match(account, /code: 'heavy'.*?maxDevices: 5, maxWindows: 5/s);
  assert.match(account, /user_level TEXT NOT NULL DEFAULT 'normal'/);
  assert.match(account, /levelDefinitions/);
  assert.match(account, /requested\.slice\(0, remaining\)/);
  assert.match(background, /allowed\.includes\(windowKey\)/);
});

test('popup exposes check-in +1, share +7 and upgrade entry', () => {
  assert.match(popup, /id="accountCheckin"/);
  assert.match(popup, /<sup>\+1<\/sup>/);
  assert.match(popup, /id="accountShare"/);
  assert.match(popup, /<sup>\+7<\/sup>/);
  assert.match(popup, /id="accountUpgrade"/);
  assert.match(rewards, /\/api\/v1\/account\/checkin/);
  assert.match(rewards, /share\?\.url/);
});

test('admin membership tab is now user configuration and user list says user level', () => {
  assert.match(plans, /用户配置/);
  assert.match(plans, /普通、深度、重度/);
  assert.match(users, /<th>用户等级<\/th>/);
});
'''
write('license-server/test/user-levels-and-popup-rewards.test.mjs', test)

# Update one existing regression test whose wording intentionally changed from 邀请 to 分享.
legacy_test = 'license-server/test/account-rewards-and-release-floor.test.mjs'
text = read(legacy_test)
text = text.replace('每成功邀请 1 个已验证账户增加 7 天', '每成功分享并带来 1 个已验证账户增加 7 天')
write(legacy_test, text)

print('USER_LEVELS_V1 migration applied')
