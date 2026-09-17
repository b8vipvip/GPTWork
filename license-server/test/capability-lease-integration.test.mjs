import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { verifyCapabilityLeaseForTest } from '../capability-lease.mjs';

const ROOT = new URL('../', import.meta.url);
const EXTENSION_ID = 'bhchcpeodphgjfjoookncemnamdbfcof';
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function waitForHealth(port, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`account server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('account server did not become healthy');
}

async function jsonRequest(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json().catch(() => ({})) };
}

function extensionBody(extra = {}) {
  return {
    extensionId: EXTENSION_ID,
    extensionVersion: 'phase-b-test',
    deviceId: 'device-phase-b-12345678',
    browserInstanceId: 'browser-phase-b-12345678',
    platform: 'test/linux',
    ...extra,
  };
}

function serverEnv({ port, dbPath, dir, privateKeyPem = '', enabled = '1' }) {
  return {
    ...process.env,
    GPTLOCK_LICENSE_HOST: '127.0.0.1',
    GPTLOCK_LICENSE_PORT: String(port),
    GPTLOCK_LICENSE_DB: dbPath,
    GPTLOCK_LICENSE_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    GPTLOCK_LICENSE_ADMIN_PASSWORD: 'phase-b-admin-password-12345',
    GPTLOCK_LICENSE_SECRET: '0123456789abcdef0123456789abcdef',
    GPTLOCK_LICENSE_ALLOWED_EXTENSION_IDS: EXTENSION_ID,
    GPTLOCK_CAPABILITY_LEASE_ENABLED: enabled,
    GPTLOCK_CAPABILITY_LEASE_PRIVATE_KEY_PEM: privateKeyPem,
    GPTLOCK_CAPABILITY_LEASE_TTL_SECONDS: '120',
    GPTLOCK_UPDATE_DATA_DIR: dir,
    GPTLOCK_UPDATE_ALLOW_WITHOUT_SYSTEMD: '1',
  };
}

test('lease-enabled startup fails closed without the deployment signing key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gptlock-lease-missing-key-'));
  const port = 35000 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: serverEnv({ port, dbPath: join(dir, 'account.sqlite3'), dir, privateKeyPem: '' }),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not fail closed')), 10_000);
      child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /GPTLOCK_CAPABILITY_LEASE_PRIVATE_KEY_PEM/);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
});

test('heartbeat mints a lease only for the admitted session and windows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gptlock-lease-integration-'));
  const dbPath = join(dir, 'account.sqlite3');
  const port = 35500 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: serverEnv({ port, dbPath, dir, privateKeyPem }),
  });

  try {
    await waitForHealth(port, child);
    const admin = await jsonRequest(`${base}/admin/api/login`, {
      method: 'POST', body: { password: 'phase-b-admin-password-12345' },
    });
    assert.equal(admin.response.status, 200);
    const cookie = admin.response.headers.get('set-cookie').split(';')[0];

    const created = await jsonRequest(`${base}/admin/api/account/users`, {
      method: 'POST', headers: { cookie }, body: {
        email: 'phase-b@example.com', password: 'PhaseB-Account-Password-12345', emailAccess: 'verified', freeDays: 7,
      },
    });
    assert.equal(created.response.status, 201);

    const login = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN },
      body: extensionBody({ email: 'phase-b@example.com', password: 'PhaseB-Account-Password-12345' }),
    });
    assert.equal(login.response.status, 200);
    const authorization = `Bearer ${login.data.sessionToken}`;

    const heartbeat = await jsonRequest(`${base}/api/v1/account/heartbeat`, {
      method: 'POST', headers: { origin: ORIGIN, authorization },
      body: extensionBody({ windowKeys: ['chrome:10000001', 'chrome:10000002'] }),
    });
    assert.equal(heartbeat.response.status, 200);
    assert.deepEqual(heartbeat.data.allowedWindowKeys, ['chrome:10000001']);
    assert.deepEqual(heartbeat.data.deniedWindowKeys, ['chrome:10000002']);
    assert.ok(heartbeat.data.capabilityLease?.leaseToken);
    assert.deepEqual(heartbeat.data.capabilityLease.windowKeys, heartbeat.data.allowedWindowKeys);

    const claims = verifyCapabilityLeaseForTest(heartbeat.data.capabilityLease.leaseToken, publicKeyPem);
    assert.ok(claims);
    assert.equal(claims.subject, `user:${created.data.user.id}`);
    assert.match(claims.sessionId, /^session:\d+$/);
    assert.equal(claims.deviceId, 'device-phase-b-12345678');
    assert.equal(claims.browserInstanceId, 'browser-phase-b-12345678');
    assert.equal(claims.extensionId, EXTENSION_ID);
    assert.deepEqual(claims.windowKeys, ['chrome:10000001']);
    assert.deepEqual(claims.features, ['evaluate_request', 'evaluate_response', 'evaluate_context']);
    assert.ok(Date.parse(heartbeat.data.capabilityLease.expiresAt) > Date.now());

    const disabled = await jsonRequest(`${base}/admin/api/account/users/${created.data.user.id}`, {
      method: 'PATCH', headers: { cookie }, body: { status: 'disabled' },
    });
    assert.equal(disabled.response.status, 200);
    const denied = await jsonRequest(`${base}/api/v1/account/heartbeat`, {
      method: 'POST', headers: { origin: ORIGIN, authorization },
      body: extensionBody({ windowKeys: ['chrome:10000001'] }),
    });
    assert.equal(denied.response.status, 401);
    assert.equal(denied.data.capabilityLease, undefined);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
});
