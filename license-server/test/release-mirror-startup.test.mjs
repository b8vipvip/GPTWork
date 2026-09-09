import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createSiteReleaseFeed } from '../site-releases.mjs';

const ORIGIN = 'https://gptlock.mv3.cn';
const updater = new URL('../scripts/update-server.sh', import.meta.url);
const installer = new URL('../scripts/install-updater-systemd.sh', import.meta.url);

test('release mirror defaults beside the configured production database instead of inside the deployed checkout', async (t) => {
  const checkout = mkdtempSync(join(tmpdir(), 'gptlock-readonly-checkout-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'gptlock-production-data-'));
  t.after(() => {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  let networkCalls = 0;
  const dbPath = join(dataDir, 'gptlock-license.sqlite3');
  const feed = createSiteReleaseFeed({
    serverRoot: checkout,
    env: {
      GPTLOCK_LICENSE_DB: dbPath,
      GPTLOCK_LICENSE_PUBLIC_ORIGIN: ORIGIN,
    },
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('must not contact GitHub without a token');
    },
  });

  assert.equal(feed.mirrorRoot, resolve(dataDir, 'releases'));
  assert.equal(existsSync(feed.mirrorRoot), true);

  const result = await feed.sync();
  assert.equal(result.ok, true);
  assert.equal(result.warning, 'private_release_token_required');
  assert.equal(networkCalls, 0);
});

test('an unavailable release mirror degrades only the update channel and never throws during server construction', async (t) => {
  const checkout = mkdtempSync(join(tmpdir(), 'gptlock-release-checkout-'));
  const root = mkdtempSync(join(tmpdir(), 'gptlock-release-storage-failure-'));
  t.after(() => {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const blocker = join(root, 'not-a-directory');
  writeFileSync(blocker, 'block directory creation\n');
  const mirrorDir = join(blocker, 'releases');
  let networkCalls = 0;

  const feed = createSiteReleaseFeed({
    serverRoot: checkout,
    env: {
      GPTLOCK_GITHUB_TOKEN: 'github_pat_read_only_test_token',
      GPTLOCK_LICENSE_PUBLIC_ORIGIN: ORIGIN,
      GPTLOCK_RELEASE_MIRROR_DIR: mirrorDir,
    },
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('storage failure must be detected before GitHub access');
    },
  });

  const initial = await feed.load();
  assert.equal(initial.ok, true);
  assert.equal(initial.warning, 'release_mirror_storage_unavailable');

  const synced = await feed.sync();
  assert.equal(synced.ok, true);
  assert.equal(synced.warning, 'release_mirror_storage_unavailable');
  assert.equal(networkCalls, 0);
});

test('system updater provisions writable mirror storage and records service diagnostics before rollback', () => {
  const updateScript = readFileSync(updater, 'utf8');
  const installScript = readFileSync(installer, 'utf8');

  assert.match(updateScript, /RELEASE_CONFIG="\$\{GPTLOCK_RELEASE_MIRROR_DIR:-\$DATA_DIR\/releases\}"/);
  assert.match(updateScript, /RELEASE_MIRROR_DIR="\$\(resolve_from "\$SERVICE_CWD" "\$RELEASE_CONFIG"\)"/);
  assert.match(updateScript, /chown "\$RUNTIME_USER:\$RUNTIME_GROUP" "\$RELEASE_MIRROR_DIR"/);
  assert.match(updateScript, /systemctl status "\$SERVICE" --no-pager -l/);
  assert.match(updateScript, /journalctl -u "\$SERVICE" -n 100 --no-pager/);

  assert.match(installScript, /RELEASE_CONFIG="\$\{GPTLOCK_RELEASE_MIRROR_DIR:-\$DATA_DIR\/releases\}"/);
  assert.match(installScript, /RELEASE_MIRROR_DIR="\$\(resolve_from/);
  assert.match(installScript, /chown "\$RUNTIME_USER:\$RUNTIME_GROUP" "\$DATA_DIR" "\$RELEASE_MIRROR_DIR"/);
});
