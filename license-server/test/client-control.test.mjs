import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createClientControlSystem } from '../client-control.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      free_expires_at TEXT,
      max_devices_override INTEGER,
      max_windows_override INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      extension_version TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;
    CREATE TABLE memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE membership_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE account_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      user_id INTEGER,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const now = new Date();
  db.prepare('INSERT INTO users(id,email,status,free_expires_at,max_devices_override,max_windows_override,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?)')
    .run('one@example.com', 'active', new Date(now.getTime() + 86400000).toISOString(), 9, 4, new Date(now.getTime() - 86400000).toISOString(), now.toISOString());
  db.prepare('INSERT INTO users(id,email,status,free_expires_at,max_devices_override,max_windows_override,created_at,updated_at) VALUES(2,?,?,?,?,?,?,?)')
    .run('two@example.com', 'active', new Date(now.getTime() + 86400000).toISOString(), null, null, now.toISOString(), now.toISOString());
  db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('account_free_days','7',?)").run(now.toISOString());
  const system = createClientControlSystem({ db, json() {}, bodyJson: async () => ({}), windowTtlSeconds: 150 });
  return { db, system, now };
}

test('client status exposes version, logged-in devices and simultaneous online devices', () => {
  const { db, system, now } = fixture();
  const future = new Date(now.getTime() + 86400000).toISOString();
  const recent = new Date(now.getTime() - 30_000).toISOString();
  const stale = new Date(now.getTime() - 10 * 60_000).toISOString();
  db.prepare('INSERT INTO user_sessions(user_id,token_hash,device_id,extension_version,last_seen_at,expires_at,revoked_at) VALUES(1,?,?,?,?,?,NULL)')
    .run('t1', 'device-a', '0.5.47', recent, future);
  db.prepare('INSERT INTO user_sessions(user_id,token_hash,device_id,extension_version,last_seen_at,expires_at,revoked_at) VALUES(1,?,?,?,?,?,NULL)')
    .run('t2', 'device-b', '0.5.46', stale, future);

  const status = system.userClientStatus(1);
  assert.equal(status.clientVersion, '0.5.47');
  assert.equal(status.online, true);
  assert.equal(status.loggedInDevices, 2);
  assert.equal(status.onlineDevices, 1);
  assert.equal(status.activeSessions, 2);
  assert.equal(status.onlineSessions, 1);
});

test('global and per-user update commands are durable for existing offline users', () => {
  const { system } = fixture();
  const first = system.queueUserUpdate(1);
  assert.equal(first.updateGeneration, 1);

  const batch = system.queueAllUpdates();
  assert.equal(batch.users, 2);
  assert.equal(batch.onlineUsers, 0);
  assert.equal(batch.offlineUsers, 2);
  assert.equal(batch.syncGeneration, 1);
  assert.equal(system.userClientStatus(1).updateGeneration, 2);
  assert.equal(system.userClientStatus(2).updateGeneration, 1);
});

test('reset account restores registration entitlement baseline and queues account sync', () => {
  const { db, system, now } = fixture();
  db.prepare('INSERT INTO account_audit_log(event,user_id,detail,created_at) VALUES(?,?,?,?)').run(
    'admin_user_created', 1,
    JSON.stringify({ freeDays: 14, maxDevicesOverride: 3, maxWindowsOverride: null }),
    new Date(now.getTime() - 5 * 86400000).toISOString(),
  );
  db.prepare("INSERT INTO memberships(user_id,status) VALUES(1,'active')").run();
  db.prepare("INSERT INTO membership_orders(user_id,status) VALUES(1,'pending')").run();

  const result = system.resetAccount(1);
  assert.equal(result.baseline.freeDays, 14);
  assert.equal(result.baseline.maxDevicesOverride, 3);
  assert.equal(result.status.accountSyncGeneration, 1);
  assert.equal(db.prepare('SELECT status FROM memberships WHERE user_id=1').get().status, 'revoked');
  assert.equal(db.prepare('SELECT status FROM membership_orders WHERE user_id=1').get().status, 'cancelled');

  const user = db.prepare('SELECT * FROM users WHERE id=1').get();
  assert.equal(user.max_devices_override, 3);
  assert.equal(user.max_windows_override, null);
  const remainingDays = (Date.parse(user.free_expires_at) - Date.now()) / 86400000;
  assert.ok(remainingDays > 13.9 && remainingDays <= 14.01);
});
