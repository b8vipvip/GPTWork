import { createHash } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ONLINE_TTL_SECONDS = 150;
const MAX_WAIT_MS = 25_000;

function nowIso() { return new Date().toISOString(); }
function sha256(value) { return createHash('sha256').update(String(value || '')).digest('hex'); }
function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}
function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function parseDetail(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function sameOrNewerGeneration(serverValue, clientValue) {
  return Number(serverValue || 0) > Math.max(0, Number(clientValue || 0));
}
function daysBetween(start, end) {
  const startMs = Date.parse(start || '');
  const endMs = Date.parse(end || '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.max(0, Math.min(3650, Math.round((endMs - startMs) / DAY_MS)));
}

export function createClientControlSystem({
  db,
  json,
  bodyJson,
  windowTtlSeconds = DEFAULT_ONLINE_TTL_SECONDS,
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_update_control (
      id INTEGER PRIMARY KEY CHECK(id=1),
      auto_update_enabled INTEGER NOT NULL DEFAULT 1 CHECK(auto_update_enabled IN (0,1)),
      sync_generation INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS user_client_control (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      update_generation INTEGER NOT NULL DEFAULT 0,
      account_sync_generation INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  db.prepare(`INSERT OR IGNORE INTO client_update_control(id,auto_update_enabled,sync_generation,updated_at)
    VALUES(1,1,0,?)`).run(nowIso());

  const waiters = new Map();
  const onlineTtlSeconds = Math.max(90, Number(windowTtlSeconds || DEFAULT_ONLINE_TTL_SECONDS));

  function controlRow() {
    return db.prepare('SELECT * FROM client_update_control WHERE id=1').get();
  }
  function userExists(userId) {
    return Boolean(db.prepare('SELECT 1 FROM users WHERE id=?').get(Number(userId)));
  }
  function ensureUserControl(userId) {
    db.prepare(`INSERT OR IGNORE INTO user_client_control(user_id,update_generation,account_sync_generation,updated_at)
      VALUES(?,0,0,?)`).run(Number(userId), nowIso());
    return db.prepare('SELECT * FROM user_client_control WHERE user_id=?').get(Number(userId));
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
  function sessionFromRequest(req) {
    const token = bearer(req);
    if (!token) return null;
    return db.prepare(`SELECT * FROM user_sessions
      WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?`).get(sha256(token), nowIso()) || null;
  }
  function notifyUser(userId) {
    const set = waiters.get(Number(userId));
    if (!set) return;
    for (const resolve of set) resolve();
    waiters.delete(Number(userId));
  }
  function notifyAll() {
    for (const userId of [...waiters.keys()]) notifyUser(userId);
  }
  function waitForUser(userId, waitMs) {
    const timeoutMs = Math.max(0, Math.min(MAX_WAIT_MS, Number(waitMs || 0)));
    if (!timeoutMs) return Promise.resolve();
    return new Promise((resolve) => {
      const id = Number(userId);
      let set = waiters.get(id);
      if (!set) { set = new Set(); waiters.set(id, set); }
      let timer = null;
      const done = () => {
        clearTimeout(timer);
        const current = waiters.get(id);
        current?.delete(done);
        if (current && current.size === 0) waiters.delete(id);
        resolve();
      };
      set.add(done);
      timer = setTimeout(done, timeoutMs);
    });
  }
  function publicConfig() {
    const row = controlRow();
    return {
      autoUpdateEnabled: Boolean(row.auto_update_enabled),
      syncGeneration: Number(row.sync_generation || 0),
      updatedAt: row.updated_at,
    };
  }
  function clientControl(userId, sinceUpdate = 0, sinceAccount = 0) {
    const user = ensureUserControl(userId);
    const config = publicConfig();
    return {
      ...config,
      updateGeneration: Number(user.update_generation || 0),
      accountSyncGeneration: Number(user.account_sync_generation || 0),
      forceUpdate: sameOrNewerGeneration(user.update_generation, sinceUpdate),
      accountSync: sameOrNewerGeneration(user.account_sync_generation, sinceAccount),
    };
  }
  function userClientStatus(userId) {
    const id = Number(userId);
    const now = nowIso();
    const cutoff = new Date(Date.now() - onlineTtlSeconds * 1000).toISOString();
    const sessions = db.prepare(`SELECT device_id,extension_version,last_seen_at,expires_at,revoked_at
      FROM user_sessions WHERE user_id=? ORDER BY last_seen_at DESC,id DESC`).all(id);
    const active = sessions.filter((row) => !row.revoked_at && row.expires_at > now);
    const online = active.filter((row) => row.last_seen_at >= cutoff);
    const latest = sessions.find((row) => String(row.extension_version || '').trim()) || null;
    const control = ensureUserControl(id);
    return {
      userId: id,
      clientVersion: latest?.extension_version || '',
      latestSeenAt: sessions[0]?.last_seen_at || null,
      online: online.length > 0,
      loggedInDevices: new Set(active.map((row) => row.device_id)).size,
      onlineDevices: new Set(online.map((row) => row.device_id)).size,
      activeSessions: active.length,
      onlineSessions: online.length,
      updateGeneration: Number(control.update_generation || 0),
      accountSyncGeneration: Number(control.account_sync_generation || 0),
    };
  }
  function allUserClientStatus() {
    return db.prepare('SELECT id FROM users ORDER BY id DESC').all().map((row) => userClientStatus(row.id));
  }
  function queueUserUpdate(userId, source = 'admin_user') {
    const id = Number(userId);
    if (!userExists(id)) return null;
    ensureUserControl(id);
    db.prepare(`UPDATE user_client_control SET update_generation=update_generation+1,updated_at=? WHERE user_id=?`)
      .run(nowIso(), id);
    const status = userClientStatus(id);
    audit('admin_client_update_queued', id, { source, updateGeneration: status.updateGeneration, online: status.online });
    notifyUser(id);
    return status;
  }
  function queueAllUpdates() {
    const stamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT OR IGNORE INTO user_client_control(user_id,update_generation,account_sync_generation,updated_at)
        SELECT id,0,0,? FROM users`).run(stamp);
      db.prepare(`UPDATE user_client_control SET update_generation=update_generation+1,updated_at=?
        WHERE user_id IN (SELECT id FROM users)`).run(stamp);
      db.prepare(`UPDATE client_update_control SET sync_generation=sync_generation+1,updated_at=? WHERE id=1`).run(stamp);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    audit('admin_client_sync_all_queued', null, { syncGeneration: controlRow().sync_generation });
    notifyAll();
    const users = allUserClientStatus();
    return {
      ...publicConfig(),
      users: users.length,
      onlineUsers: users.filter((row) => row.online).length,
      offlineUsers: users.filter((row) => !row.online).length,
    };
  }
  function registrationBaseline(user) {
    const rows = db.prepare(`SELECT event,detail,created_at FROM account_audit_log
      WHERE user_id=? AND event IN ('admin_user_created','account_registered','email_verified') ORDER BY id ASC`).all(user.id);
    let freeDays = null;
    let maxDevicesOverride = null;
    let maxWindowsOverride = null;
    for (const row of rows) {
      const detail = parseDetail(row.detail);
      if (row.event === 'admin_user_created') {
        if (Number.isInteger(Number(detail.freeDays))) freeDays = Math.max(0, Math.min(3650, Number(detail.freeDays)));
        maxDevicesOverride = detail.maxDevicesOverride === null || detail.maxDevicesOverride === undefined ? null : clampInt(detail.maxDevicesOverride, 1, 1000, null);
        maxWindowsOverride = detail.maxWindowsOverride === null || detail.maxWindowsOverride === undefined ? null : clampInt(detail.maxWindowsOverride, 1, 1000, null);
        break;
      }
      if (row.event === 'account_registered' && detail.freeExpiresAt) {
        freeDays = daysBetween(row.created_at, detail.freeExpiresAt);
        break;
      }
      if (row.event === 'email_verified' && detail.freeExpiresAt) {
        freeDays = daysBetween(row.created_at, detail.freeExpiresAt);
        break;
      }
    }
    if (freeDays === null) {
      const setting = db.prepare(`SELECT value FROM app_settings WHERE key='account_free_days'`).get();
      freeDays = clampInt(setting?.value, 0, 3650, 7);
    }
    return { freeDays, maxDevicesOverride, maxWindowsOverride };
  }
  function resetAccount(userId) {
    const id = Number(userId);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!user) return null;
    const baseline = registrationBaseline(user);
    const stamp = nowIso();
    const freeExpiresAt = new Date(Date.now() + baseline.freeDays * DAY_MS).toISOString();
    ensureUserControl(id);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE memberships SET status='revoked' WHERE user_id=? AND status='active'`).run(id);
      db.prepare(`UPDATE membership_orders SET status='cancelled' WHERE user_id=? AND status='pending'`).run(id);
      db.prepare(`UPDATE users SET free_expires_at=?,max_devices_override=?,max_windows_override=?,updated_at=? WHERE id=?`)
        .run(freeExpiresAt, baseline.maxDevicesOverride, baseline.maxWindowsOverride, stamp, id);
      db.prepare(`UPDATE user_client_control SET account_sync_generation=account_sync_generation+1,updated_at=? WHERE user_id=?`)
        .run(stamp, id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    const status = userClientStatus(id);
    audit('admin_account_reset', id, {
      freeDays: baseline.freeDays,
      freeExpiresAt,
      maxDevicesOverride: baseline.maxDevicesOverride,
      maxWindowsOverride: baseline.maxWindowsOverride,
      accountSyncGeneration: status.accountSyncGeneration,
    });
    notifyUser(id);
    return { status, baseline: { ...baseline, freeExpiresAt } };
  }

  async function handleSite(req, res, url) {
    if (url.pathname !== '/site/api/client-update/config' || req.method !== 'GET') return false;
    json(res, 200, { ok: true, ...publicConfig() });
    return true;
  }

  async function handleApi(req, res, url, cors = {}) {
    if (url.pathname !== '/api/v1/client/control' || req.method !== 'GET') return false;
    const session = sessionFromRequest(req);
    if (!session) {
      json(res, 401, { ok: false, error: { code: 'SESSION_REQUIRED', message: '登录会话无效或已过期' } }, cors);
      return true;
    }
    const sinceUpdate = Math.max(0, Number(url.searchParams.get('sinceUpdate') || 0));
    const sinceAccount = Math.max(0, Number(url.searchParams.get('sinceAccount') || 0));
    let control = clientControl(session.user_id, sinceUpdate, sinceAccount);
    if (!control.forceUpdate && !control.accountSync) {
      const waitMs = clampInt(url.searchParams.get('wait'), 0, MAX_WAIT_MS, 0);
      if (waitMs) {
        await waitForUser(session.user_id, waitMs);
        control = clientControl(session.user_id, sinceUpdate, sinceAccount);
      }
    }
    db.prepare('UPDATE user_sessions SET last_seen_at=? WHERE id=?').run(nowIso(), session.id);
    json(res, 200, { ok: true, control, serverTime: nowIso() }, cors);
    return true;
  }

  async function handleAdmin(req, res, url) {
    const path = url.pathname;
    if (path === '/admin/api/client-control' && req.method === 'GET') {
      json(res, 200, { ok: true, config: publicConfig() });
      return true;
    }
    if (path === '/admin/api/client-control' && req.method === 'PUT') {
      const input = await bodyJson(req);
      const enabled = input.autoUpdateEnabled !== false;
      db.prepare(`UPDATE client_update_control SET auto_update_enabled=?,updated_at=? WHERE id=1`).run(enabled ? 1 : 0, nowIso());
      audit('admin_client_auto_update_changed', null, { enabled });
      notifyAll();
      json(res, 200, { ok: true, config: publicConfig() });
      return true;
    }
    if (path === '/admin/api/client-control/sync-all' && req.method === 'POST') {
      json(res, 202, { ok: true, queued: queueAllUpdates() });
      return true;
    }
    if (path === '/admin/api/client-control/users' && req.method === 'GET') {
      json(res, 200, { ok: true, onlineTtlSeconds, users: allUserClientStatus() });
      return true;
    }
    const updateMatch = path.match(/^\/admin\/api\/client-control\/users\/(\d+)\/update$/);
    if (updateMatch && req.method === 'POST') {
      const status = queueUserUpdate(Number(updateMatch[1]));
      if (!status) json(res, 404, { ok: false, error: { code: 'USER_NOT_FOUND', message: '用户不存在' } });
      else json(res, 202, { ok: true, queued: true, user: status });
      return true;
    }
    const resetMatch = path.match(/^\/admin\/api\/client-control\/users\/(\d+)\/reset-account$/);
    if (resetMatch && req.method === 'POST') {
      const result = resetAccount(Number(resetMatch[1]));
      if (!result) json(res, 404, { ok: false, error: { code: 'USER_NOT_FOUND', message: '用户不存在' } });
      else json(res, 200, { ok: true, reset: true, ...result });
      return true;
    }
    return false;
  }

  return {
    handleSite,
    handleApi,
    handleAdmin,
    publicConfig,
    userClientStatus,
    queueUserUpdate,
    queueAllUpdates,
    resetAccount,
  };
}
