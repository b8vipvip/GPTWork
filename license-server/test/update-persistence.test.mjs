import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), 'utf8');

test('update manager resolves legacy relative runtime data paths to absolute paths', () => {
  const source = read('update-manager.mjs');
  assert.match(source, /const absoluteDbPath = resolve\(dbPath\)/);
  assert.match(source, /const dataDir = resolve\(env\.GPTLOCK_UPDATE_DATA_DIR \|\| dirname\(absoluteDbPath\)\)/);
});

test('systemd installer pins the currently active database as an absolute persistent path', () => {
  const source = read('scripts/install-updater-systemd.sh');
  assert.match(source, /\/proc\/\$MAIN_PID\/cwd/);
  assert.match(source, /20-gptwork-persistent-data\.conf/);
  assert.match(source, /Environment="GPTLOCK_LICENSE_DB=\$DB_PATH"/);
  assert.match(source, /Environment="GPTLOCK_UPDATE_DB_PATH=\$DB_PATH"/);
  assert.match(source, /Persistent database not found/);
});

test('server updater refuses database replacement and preserves pre-existing app settings', () => {
  const source = read('scripts/update-server.sh');
  assert.match(source, /拒绝更新以避免初始化空数据库/);
  assert.match(source, /DB_IDENTITY_BEFORE=.*stat -Lc/);
  assert.match(source, /DB_IDENTITY_AFTER=.*stat -Lc/);
  assert.match(source, /SERVICE_DB_OK=0/);
  assert.match(source, /重启后的服务没有打开更新前的持久化数据库/);
  assert.match(source, /snapshot_app_settings/);
  assert.match(source, /verify_app_settings/);
  assert.match(source, /restore_app_settings/);
  assert.match(source, /已有配置被修改或重置/);
});
