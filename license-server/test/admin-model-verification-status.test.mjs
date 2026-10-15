import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const ROOT = new URL('../', import.meta.url);
const EXTENSION_ID = 'bhchcpeodphgjfjoookncemnamdbfcof';
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(base, child, errors) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`server exited: ${errors.join('')}`);
    try {
      const response = await fetch(`${base}/api/v1/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server health timeout: ${errors.join('')}`);
}

async function request(base, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

test('administrator can edit verification status without falsifying four-stage proof or overriding enabled', { timeout: 35000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gptwork-model-status-'));
  const dbPath = join(dir, 'account.sqlite3');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const errors = [];
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GPTLOCK_LICENSE_HOST: '127.0.0.1',
      GPTLOCK_LICENSE_PORT: String(port),
      GPTLOCK_LICENSE_DB: dbPath,
      GPTLOCK_LICENSE_RUNTIME_LOG: join(dir, 'runtime.log'),
      GPTLOCK_LICENSE_PUBLIC_ORIGIN: base,
      GPTLOCK_LICENSE_ADMIN_PASSWORD: 'admin-password-123456',
      GPTLOCK_LICENSE_SECRET: '0123456789abcdef0123456789abcdef',
      GPTLOCK_LICENSE_ALLOWED_EXTENSION_IDS: EXTENSION_ID,
      GPTLOCK_ACCOUNT_EMAIL_TEST_MODE: '1',
      GPTLOCK_UPDATE_DATA_DIR: dir,
      GPTLOCK_UPDATE_ALLOW_WITHOUT_SYSTEMD: '1',
    },
  });
  child.stderr.on('data', (chunk) => errors.push(String(chunk)));
  let db;
  try {
    await waitForHealth(base, child, errors);
    db = new DatabaseSync(dbPath);
    const stamp = new Date().toISOString();
    db.prepare('INSERT INTO shared_model_catalog(model_id,display_name,picker_mode,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)')
      .run('gpt-6-status-test', 'GPT-6 status test', 'A', stamp, stamp);

    // Authenticate as administrator and retain the HTTP-only session cookie.
    const adminLogin = await fetch(base + '/admin/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin-password-123456' }),
    });
    assert.equal(adminLogin.status, 200);
    const adminHeaders = { cookie: adminLogin.headers.get('set-cookie').split(';')[0] };
    const getAdmin = () => request(base, '/admin/api/account/model-catalog', { headers: adminHeaders });
    const putAdmin = (body) => request(base, '/admin/api/account/model-catalog', {
      method: 'PUT', headers: adminHeaders, body: { model: 'gpt-6-status-test', ...body },
    });
    const row = (data) => data.models.find((item) => item.model === 'gpt-6-status-test');

    const original = await getAdmin();
    assert.equal(original.status, 200);
    assert.equal(row(original.data).verificationStatusOverride, 'auto');
    assert.equal(row(original.data).verificationStatus, 'pending');
    assert.equal(row(original.data).verificationStatusSource, 'automatic');
    assert.equal(row(original.data).clientEligible, false);
    assert.equal(row(original.data).enabled, true);

    const verified = await putAdmin({ verificationStatusOverride: 'verified' });
    assert.equal(verified.status, 200);
    assert.equal(row(verified.data).verificationStatus, 'verified');
    assert.equal(row(verified.data).verificationStatusSource, 'manual');
    assert.equal(row(verified.data).clientEligibleAccountCount, 0);
    assert.equal(row(verified.data).clientEligible, false);
    assert.equal(row(verified.data).verifiedAccountCount, 0);
    assert.ok(verified.data.generation > original.data.generation);

    const unchanged = await putAdmin({ verificationStatusOverride: 'verified' });
    assert.equal(unchanged.data.generation, verified.data.generation);
    const invalid = await putAdmin({ verificationStatusOverride: 'made-up' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error.code, 'INVALID_MODEL_VERIFICATION_STATUS');

    const created = await request(base, '/admin/api/account/users', {
      method: 'POST', headers: adminHeaders,
      body: { email: 'catalog-status@example.com', password: 'AccountPassword-12345', emailAccess: 'verified' },
    });
    assert.equal(created.status, 201);
    const clientLogin = await request(base, '/api/v1/auth/login', {
      method: 'POST', headers: { origin: ORIGIN },
      body: {
        extensionId: EXTENSION_ID, extensionVersion: 'test', deviceId: 'status-device-12345678',
        browserInstanceId: 'status-browser-12345678', platform: 'test/linux',
        email: 'catalog-status@example.com', password: 'AccountPassword-12345',
      },
    });
    assert.equal(clientLogin.status, 200);
    const clientHeaders = { origin: ORIGIN, authorization: `Bearer ${clientLogin.data.sessionToken}` };
    const clientCatalog = () => request(base, '/api/v1/account/model-catalog', { headers: clientHeaders });
    const enabledCatalog = await clientCatalog();
    assert.equal(enabledCatalog.status, 200);
    assert.equal(row(enabledCatalog.data).verificationStatus, 'verified');
    assert.equal(row(enabledCatalog.data).clientEligible, false);

    const failed = await putAdmin({ verificationStatusOverride: 'failed' });
    assert.equal(row(failed.data).verificationStatus, 'failed');
    assert.ok(row((await clientCatalog()).data), 'manual failure must not silently disable a model');
    const disabled = await putAdmin({ enabled: false });
    assert.equal(row(disabled.data).enabled, false);
    assert.equal(row((await clientCatalog()).data), undefined, 'only enabled determines frontend exposure');

    const enabled = await putAdmin({ enabled: true });
    assert.equal(row(enabled.data).verificationStatusOverride, 'failed');
    const deleted = await request(base, '/admin/api/account/model-catalog', {
      method: 'DELETE', headers: adminHeaders, body: { model: 'gpt-6-status-test' },
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.trash.find((item) => item.model === 'gpt-6-status-test').verificationStatusOverride, 'failed');
    const restored = await request(base, '/admin/api/account/model-catalog/restore', {
      method: 'POST', headers: adminHeaders, body: { model: 'gpt-6-status-test' },
    });
    assert.equal(restored.status, 200);
    assert.equal(row(restored.data).verificationStatusOverride, 'failed');

    const reset = await putAdmin({ verificationStatusOverride: 'auto' });
    assert.equal(row(reset.data).verificationStatus, 'pending');
    assert.equal(row(reset.data).verificationStatusSource, 'automatic');
    assert.equal(db.prepare('SELECT count(*) AS n FROM shared_model_account_seen WHERE model_id=?').get('gpt-6-status-test').n, 0);
    assert.equal(db.prepare('SELECT verification_status_override AS status FROM shared_model_catalog WHERE model_id=?').get('gpt-6-status-test').status, 'auto');
  } finally {
    db?.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
    await rm(dir, { recursive: true, force: true });
  }
});
