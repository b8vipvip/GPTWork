import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, chmodSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const updater = readFileSync(new URL('../scripts/update-server.sh', import.meta.url), 'utf8');
const preflightScript = updater.match(/sqlite_preflight\(\) \{[\s\S]*?\$NODE_BIN" --input-type=module -e '([\s\S]*?)' >>"\$LOG_FILE"/)?.[1];

test('updater never opens live SQLite as root and checks the actual runtime user before deploy', () => {
  assert.ok(preflightScript, 'SQLite preflight must be executable as a standalone Node snippet');
  assert.match(updater, /runuser -u "\$RUNTIME_USER" -g "\$RUNTIME_GROUP" -- "\$@"/);
  assert.match(updater, /run_as_runtime env DB_PATH_ENV="\$DB_PATH" SNAPSHOT_ENV="\$SETTINGS_SNAPSHOT"/);
  assert.match(updater, /run_as_runtime env DB_PATH_ENV="\$DB_PATH" BACKUP_PATH_ENV="\$BACKUP_PATH"/);
  assert.equal((updater.match(/run_as_runtime env DB_PATH_ENV=/g) || []).length, 5);
  assert.match(updater, /sqlite_preflight\npin_persistent_paths/);
  assert.match(updater, /sqlite_preflight\nsnapshot_app_settings/);
  assert.match(updater, /sqlite_preflight\nlog "Database backup:/);
  assert.match(updater, /chown "\$RUNTIME_USER:\$RUNTIME_GROUP" "\$BACKUP_DIR"/);
  assert.match(updater, /log_sqlite_diagnostics\n  systemctl status/);
  assert.match(updater, /rollback_ok=0/);
  assert.doesNotMatch(updater, /rm -f "\$DB_PATH(-wal|-shm)?"/);
});

test('WAL preflight checks real SQLite access and does not replace the DB or remove sidecars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gptwork-updater-sqlite-'));
  const path = join(dir, 'db.sqlite3');
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES(1);');
    const before = statSync(path);
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', preflightScript], {
      env: { ...process.env, DB_PATH_ENV: path }, encoding: 'utf8',
    });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(statSync(path).ino, before.ino);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);

    if (process.getuid?.() !== 0) {
      chmodSync(path, 0o400);
      const invalid = run();
      assert.notEqual(invalid.status, 0, 'runtime identity must reject a non-writable DB');
      chmodSync(path, 0o600);
      assert.equal(run().status, 0);
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
