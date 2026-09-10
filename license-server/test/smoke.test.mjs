import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const EXTENSION_ID = 'bhchcpeodphgjfjoookncemnamdbfcof';
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function waitForHealth(port, child) {
  const deadline = Date.now() + 10000;
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
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function extensionBody(extra = {}) {
  return {
    extensionId: EXTENSION_ID,
    extensionVersion: 'test',
    deviceId: 'device-12345678',
    browserInstanceId: 'browser-12345678',
    platform: 'test/linux',
    ...extra,
  };
}

async function testOutbox(base, cookie) {
  const { response, data } = await jsonRequest(`${base}/admin/api/account/test-outbox`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return data.messages || [];
}

function latestCode(messages, email, purpose) {
  const row = [...messages].reverse().find((item) => item.to === email && item.purpose === purpose);
  assert.ok(row, `missing ${purpose} email for ${email}`);
  assert.match(row.code, /^\d{6}$/);
  return row.code;
}

test('account system verifies email, enforces user levels and rewards, and protects credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gptlock-account-test-'));
  const dbPath = join(dir, 'account.sqlite3');
  const runtimeLogPath = join(dir, 'runtime.log');
  const port = 33000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const adminPassword = 'test-admin-password-12345';
  const initialPassword = 'AccountPassword-12345';
  const resetPassword = 'ResetPassword-67890';
  const email = 'member@example.com';

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GPTLOCK_LICENSE_HOST: '127.0.0.1',
      GPTLOCK_LICENSE_PORT: String(port),
      GPTLOCK_LICENSE_DB: dbPath,
      GPTLOCK_LICENSE_RUNTIME_LOG: runtimeLogPath,
      GPTLOCK_LICENSE_PUBLIC_ORIGIN: base,
      GPTLOCK_LICENSE_ADMIN_PASSWORD: adminPassword,
      GPTLOCK_LICENSE_SECRET: '0123456789abcdef0123456789abcdef',
      GPTLOCK_LICENSE_ALLOWED_EXTENSION_IDS: EXTENSION_ID,
      GPTLOCK_LICENSE_ADMIN_LOGIN_MAX_ATTEMPTS: '3',
      GPTLOCK_ACCOUNT_LOGIN_MAX_ATTEMPTS: '4',
      GPTLOCK_ACCOUNT_EMAIL_MAX_ATTEMPTS: '5',
      GPTLOCK_ACCOUNT_EMAIL_TEST_MODE: '1',
      GPTLOCK_UPDATE_DATA_DIR: dir,
      GPTLOCK_UPDATE_ALLOW_WITHOUT_SYSTEMD: '1',
    },
  });

  let inspectDb;
  try {
    await waitForHealth(port, child);

    // Admin brute-force protection remains active.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await jsonRequest(`${base}/admin/api/login`, {
        method: 'POST', headers: { 'x-forwarded-for': '203.0.113.10' }, body: { password: 'wrong-password' },
      });
      assert.equal(failed.response.status, 401);
    }
    const limited = await jsonRequest(`${base}/admin/api/login`, {
      method: 'POST', headers: { 'x-forwarded-for': '203.0.113.10' }, body: { password: 'wrong-password' },
    });
    assert.equal(limited.response.status, 429);

    const loginAdmin = await jsonRequest(`${base}/admin/api/login`, {
      method: 'POST', headers: { 'x-forwarded-for': '203.0.113.11' }, body: { password: adminPassword },
    });
    assert.equal(loginAdmin.response.status, 200);
    const cookie = loginAdmin.response.headers.get('set-cookie').split(';')[0];

    // Public config advertises account auth and old license APIs are retired.
    const adminHtml = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
    const adminUsersHtml = await readFile(new URL('../public/admin-users.html', import.meta.url), 'utf8');
    const adminSettingsHtml = await readFile(new URL('../public/admin-settings.html', import.meta.url), 'utf8');
    const adminJs = await readFile(new URL('../public/admin.js', import.meta.url), 'utf8');
    assert.match(adminHtml, /data-admin-page="overview"/);
    assert.doesNotMatch(adminHtml, /id="users"/);
    assert.match(adminUsersHtml, /id="createUserToggle"/);
    assert.match(adminUsersHtml, /id="createUserPanel"/);
    assert.match(adminUsersHtml, /id="userPasswordDialog"/);
    assert.doesNotMatch(adminUsersHtml, /窗口上限/);
    assert.match(adminSettingsHtml, /id="emailVerificationRequired"/);
    assert.doesNotMatch(adminSettingsHtml, /同时窗口上限/);
    assert.match(adminJs, /emailVerificationRequired/);
    assert.match(adminJs, /\/admin\/api\/account\/users/);
    assert.match(adminJs, /saveUserRow/);
    assert.doesNotMatch(adminJs, /\bprompt\(/);

    const config = await jsonRequest(`${base}/api/v1/config`, { headers: { origin: ORIGIN } });
    assert.equal(config.response.status, 200);
    assert.equal(config.data.accountRequired, true);
    assert.equal(config.data.licenseRequired, false);
    assert.equal(config.response.headers.get('access-control-allow-origin'), ORIGIN);

    const accountConfig = await jsonRequest(`${base}/api/v1/account/config`, { headers: { origin: ORIGIN } });
    assert.equal(accountConfig.response.status, 200);
    assert.equal(accountConfig.data.emailVerificationRequired, true);
    assert.equal(accountConfig.data.free.days, 7);
    assert.equal(accountConfig.data.free.maxDevices, 1);
    assert.equal(accountConfig.data.free.maxWindows, 1);
    assert.deepEqual(accountConfig.data.plans.map((plan) => plan.code), ['deep', 'heavy']);
    assert.deepEqual(accountConfig.data.levels.map((level) => level.code), ['normal', 'deep', 'heavy']);

    // Admin can disable registration email verification. New accounts activate immediately,
    // while the default remains enabled for backward-compatible production behavior.
    const disableVerification = await jsonRequest(`${base}/admin/api/account/settings`, {
      method: 'PUT', headers: { cookie }, body: { emailVerificationRequired: false },
    });
    assert.equal(disableVerification.response.status, 200);
    assert.equal(disableVerification.data.settings.emailVerificationRequired, false);

    const disabledVerificationConfig = await jsonRequest(`${base}/api/v1/account/config`, { headers: { origin: ORIGIN } });
    assert.equal(disabledVerificationConfig.response.status, 200);
    assert.equal(disabledVerificationConfig.data.emailVerificationRequired, false);

    const instantEmail = 'instant@example.com';
    const verifyMailCountBefore = (await testOutbox(base, cookie)).filter((row) => row.to === instantEmail && row.purpose === 'verify_email').length;
    const instantRegister = await jsonRequest(`${base}/api/v1/auth/register`, {
      method: 'POST', headers: { origin: ORIGIN }, body: extensionBody({ email: instantEmail, password: initialPassword }),
    });
    assert.equal(instantRegister.response.status, 201);
    assert.equal(instantRegister.data.verificationRequired, false);
    assert.ok(Date.parse(instantRegister.data.freeExpiresAt) > Date.now());
    const verifyMailCountAfter = (await testOutbox(base, cookie)).filter((row) => row.to === instantEmail && row.purpose === 'verify_email').length;
    assert.equal(verifyMailCountAfter, verifyMailCountBefore);

    const instantLogin = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.12' },
      body: extensionBody({ email: instantEmail, password: initialPassword }),
    });
    assert.equal(instantLogin.response.status, 200);
    assert.equal(instantLogin.data.account.user.emailVerified, false);
    assert.equal(instantLogin.data.account.user.emailVerificationExempt, true);
    assert.equal(instantLogin.data.account.entitlement.source, 'level');
    assert.equal(instantLogin.data.account.level.code, 'normal');

    const enableVerification = await jsonRequest(`${base}/admin/api/account/settings`, {
      method: 'PUT', headers: { cookie }, body: { emailVerificationRequired: true },
    });
    assert.equal(enableVerification.response.status, 200);
    assert.equal(enableVerification.data.settings.emailVerificationRequired, true);

    // Re-enabling verification must not retroactively lock accounts created while exemption was enabled.
    const instantLoginAfterEnable = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.13' },
      body: extensionBody({ email: instantEmail, password: initialPassword }),
    });
    assert.equal(instantLoginAfterEnable.response.status, 200);
    assert.equal(instantLoginAfterEnable.data.account.user.emailVerificationExempt, true);

    // Administrator can create accounts without exposing plaintext passwords.
    const manualEmail = 'manual@example.com';
    const manualPassword = 'ManualAccount-12345';
    const manualCreate = await jsonRequest(`${base}/admin/api/account/users`, {
      method: 'POST', headers: { cookie }, body: {
        email: manualEmail, password: manualPassword, emailAccess: 'verified', freeDays: 14,
        maxDevicesOverride: 3, maxWindowsOverride: 4,
      },
    });
    assert.equal(manualCreate.response.status, 201);
    assert.equal(manualCreate.data.user.email, manualEmail);
    assert.equal(manualCreate.data.user.emailVerified, true);
    assert.equal(manualCreate.data.user.emailVerificationExempt, false);
    assert.equal(manualCreate.data.user.entitlement.limits.devices, 3);
    assert.equal(manualCreate.data.user.entitlement.limits.windows, 4);
    assert.equal(JSON.stringify(manualCreate.data).includes(manualPassword), false);

    const manualLogin = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.14' },
      body: extensionBody({ email: manualEmail, password: manualPassword, deviceId: 'manual-device-12345678', browserInstanceId: 'manual-browser-12345678' }),
    });
    assert.equal(manualLogin.response.status, 200);
    assert.equal(manualLogin.data.account.user.email, manualEmail);
    assert.equal(manualLogin.data.account.entitlement.source, 'level');
    assert.equal(manualLogin.data.account.level.code, 'normal');

    const duplicateManual = await jsonRequest(`${base}/admin/api/account/users`, {
      method: 'POST', headers: { cookie }, body: { email: manualEmail, password: manualPassword },
    });
    assert.equal(duplicateManual.response.status, 409);
    assert.equal(duplicateManual.data.error.code, 'ACCOUNT_EXISTS');

    const weakManual = await jsonRequest(`${base}/admin/api/account/users`, {
      method: 'POST', headers: { cookie }, body: { email: 'weak@example.com', password: 'short' },
    });
    assert.equal(weakManual.response.status, 400);
    assert.equal(weakManual.data.error.code, 'WEAK_PASSWORD');

    // Administrator can change an existing user's password; plaintext never returns and every old session is revoked.
    const adminChangedPassword = 'AdminChanged-24680';
    const passwordChange = await jsonRequest(`${base}/admin/api/account/users/${manualCreate.data.user.id}/password`, {
      method: 'POST', headers: { cookie }, body: { password: adminChangedPassword },
    });
    assert.equal(passwordChange.response.status, 200);
    assert.equal(passwordChange.data.sessionsRevoked, true);
    assert.equal(JSON.stringify(passwordChange.data).includes(adminChangedPassword), false);

    const oldManualSession = await jsonRequest(`${base}/api/v1/account/me`, {
      headers: { origin: ORIGIN, authorization: `Bearer ${manualLogin.data.sessionToken}` },
    });
    assert.equal(oldManualSession.response.status, 401);

    const oldManualPasswordLogin = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.16' },
      body: extensionBody({ email: manualEmail, password: manualPassword, deviceId: 'manual-device-old-12345678', browserInstanceId: 'manual-browser-old-12345678' }),
    });
    assert.equal(oldManualPasswordLogin.response.status, 401);

    const newManualPasswordLogin = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.17' },
      body: extensionBody({ email: manualEmail, password: adminChangedPassword, deviceId: 'manual-device-new-12345678', browserInstanceId: 'manual-browser-new-12345678' }),
    });
    assert.equal(newManualPasswordLogin.response.status, 200);

    const editedManualEmail = 'manual-edited@example.com';
    const editedExpiry = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
    const userEdit = await jsonRequest(`${base}/admin/api/account/users/${manualCreate.data.user.id}`, {
      method: 'PATCH', headers: { cookie }, body: {
        email: editedManualEmail, status: 'active', entitlementExpiresAt: editedExpiry,
        maxDevicesOverride: 5, maxWindowsOverride: 6,
      },
    });
    assert.equal(userEdit.response.status, 200);
    assert.equal(userEdit.data.user.email, editedManualEmail);
    assert.equal(userEdit.data.user.entitlement.limits.devices, 5);
    assert.equal(userEdit.data.user.entitlement.limits.windows, 6);

    // Admin can also explicitly create a verification-exempt account even while global verification is enabled.
    const exemptManualEmail = 'manual-exempt@example.com';
    const exemptManualPassword = 'ManualExempt-12345';
    const exemptManual = await jsonRequest(`${base}/admin/api/account/users`, {
      method: 'POST', headers: { cookie }, body: { email: exemptManualEmail, password: exemptManualPassword, emailAccess: 'exempt', freeDays: 3 },
    });
    assert.equal(exemptManual.response.status, 201);
    assert.equal(exemptManual.data.user.emailVerified, false);
    assert.equal(exemptManual.data.user.emailVerificationExempt, true);
    const exemptManualLogin = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.15' },
      body: extensionBody({ email: exemptManualEmail, password: exemptManualPassword, deviceId: 'exempt-device-12345678', browserInstanceId: 'exempt-browser-12345678' }),
    });
    assert.equal(exemptManualLogin.response.status, 200);

    const legacy = await jsonRequest(`${base}/api/v1/licenses/activate`, {
      method: 'POST', headers: { origin: ORIGIN }, body: extensionBody({ code: 'GPTL-AAAA-BBBB-CCCC-DDDD-EEEE' }),
    });
    assert.equal(legacy.response.status, 410);
    assert.equal(legacy.data.error.code, 'LICENSE_API_REMOVED');

    const legacyAdmin = await jsonRequest(`${base}/admin/api/licenses`, { headers: { cookie } });
    assert.equal(legacyAdmin.response.status, 410);
    assert.equal(legacyAdmin.data.error.code, 'LICENSE_ADMIN_REMOVED');

    // A foreign extension cannot register.
    const rejectedExtension = await jsonRequest(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      body: { ...extensionBody({ email: 'foreign@example.com', password: initialPassword }), extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    assert.equal(rejectedExtension.response.status, 403);
    assert.equal(rejectedExtension.data.error.code, 'EXTENSION_NOT_ALLOWED');

    // Register -> email verification.
    const register = await jsonRequest(`${base}/api/v1/auth/register`, {
      method: 'POST', headers: { origin: ORIGIN }, body: extensionBody({ email, password: initialPassword }),
    });
    assert.equal(register.response.status, 201);
    assert.equal(register.data.verificationRequired, true);
    assert.equal(register.data.email, email);

    const verifyCode = latestCode(await testOutbox(base, cookie), email, 'verify_email');
    const verify = await jsonRequest(`${base}/api/v1/auth/verify-email`, {
      method: 'POST', headers: { origin: ORIGIN }, body: extensionBody({ email, code: verifyCode }),
    });
    assert.equal(verify.response.status, 200);
    assert.equal(verify.data.verified, true);
    assert.ok(Date.parse(verify.data.freeExpiresAt) > Date.now());

    // Wrong credentials do not expose account-specific detail.
    const wrongLogin = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.20' }, body: extensionBody({ email, password: 'WrongPassword-12345' }),
    });
    assert.equal(wrongLogin.response.status, 401);
    assert.equal(wrongLogin.data.error.code, 'LOGIN_FAILED');

    // First device logs in as a normal user; the 1-window level limit is enforced server-side.
    const userLogin = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.21' }, body: extensionBody({ email, password: initialPassword }),
    });
    assert.equal(userLogin.response.status, 200);
    assert.ok(userLogin.data.sessionToken.length >= 40);
    assert.equal(userLogin.data.account.authenticated, true);
    assert.equal(userLogin.data.account.entitlement.source, 'level');
    assert.equal(userLogin.data.account.level.code, 'normal');
    assert.deepEqual(userLogin.data.account.entitlement.limits, { devices: 1, windows: 1 });
    const firstToken = userLogin.data.sessionToken;

    const rewardsBefore = await jsonRequest(`${base}/api/v1/account/rewards`, {
      headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` },
    });
    assert.equal(rewardsBefore.response.status, 200);
    assert.equal(rewardsBefore.data.rewards.checkin.checkedInToday, false);
    assert.equal(rewardsBefore.data.rewards.checkin.rewardDays, 1);
    assert.equal(rewardsBefore.data.rewards.share.rewardDays, 7);
    assert.match(rewardsBefore.data.rewards.share.url, /\/account\?invite=GW-/);
    const expiryBeforeCheckin = Date.parse(userLogin.data.account.entitlement.expiresAt);
    const checkin = await jsonRequest(`${base}/api/v1/account/checkin`, {
      method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` }, body: {},
    });
    assert.equal(checkin.response.status, 200);
    assert.equal(checkin.data.rewards.checkin.checkedInToday, true);
    assert.ok(Date.parse(checkin.data.account.entitlement.expiresAt) >= expiryBeforeCheckin + 24 * 60 * 60 * 1000 - 1000);

    const heartbeat = await jsonRequest(`${base}/api/v1/account/heartbeat`, {
      method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` },
      body: extensionBody({ windowKeys: ['chrome:10000001', 'chrome:10000002'] }),
    });
    assert.equal(heartbeat.response.status, 200);
    assert.deepEqual(heartbeat.data.allowedWindowKeys, ['chrome:10000001']);
    assert.deepEqual(heartbeat.data.deniedWindowKeys, ['chrome:10000002']);
    assert.equal(heartbeat.data.account.entitlement.usage.windows, 1);

    const secondDevice = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.22' },
      body: extensionBody({ email, password: initialPassword, deviceId: 'device-87654321', browserInstanceId: 'browser-87654321' }),
    });
    assert.equal(secondDevice.response.status, 409);
    assert.equal(secondDevice.data.error.code, 'DEVICE_LIMIT');
    assert.equal(secondDevice.data.error.details.limit, 1);
    assert.equal(secondDevice.data.error.details.requiredReleaseCount, 1);
    assert.equal(secondDevice.data.error.details.devices.length, 1);
    assert.equal(Object.hasOwn(secondDevice.data.error.details.devices[0], 'device_id'), false);

    // Admin can find the user, override limits, and cross-origin browser writes are rejected.
    const listUsers = await jsonRequest(`${base}/admin/api/account/users?q=member%40example.com`, { headers: { cookie } });
    assert.equal(listUsers.response.status, 200);
    assert.equal(listUsers.data.users.length, 1);
    const user = listUsers.data.users[0];
    assert.equal(user.email, email);

    const csrfBlocked = await jsonRequest(`${base}/admin/api/account/users/${user.id}`, {
      method: 'PATCH', headers: { cookie, origin: 'https://evil.example' }, body: { maxDevicesOverride: 99 },
    });
    assert.equal(csrfBlocked.response.status, 403);
    assert.equal(csrfBlocked.data.error.code, 'ADMIN_ORIGIN_MISMATCH');

    const override = await jsonRequest(`${base}/admin/api/account/users/${user.id}`, {
      method: 'PATCH', headers: { cookie }, body: { maxDevicesOverride: 2, maxWindowsOverride: 2 },
    });
    assert.equal(override.response.status, 200);
    assert.equal(override.data.user.entitlement.limits.devices, 2);
    assert.equal(override.data.user.entitlement.limits.windows, 2);

    const secondDeviceAllowed = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.23' },
      body: extensionBody({ email, password: initialPassword, deviceId: 'device-87654321', browserInstanceId: 'browser-87654321' }),
    });
    assert.equal(secondDeviceAllowed.response.status, 200);
    const secondToken = secondDeviceAllowed.data.sessionToken;

    // Account center can list its own devices/sessions without exposing raw device identifiers.
    const securityBefore = await jsonRequest(`${base}/api/v1/account/security`, { headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` } });
    assert.equal(securityBefore.response.status, 200);
    assert.equal(securityBefore.data.security.devices.length, 2);
    assert.equal(securityBefore.data.security.sessions.length, 2);
    assert.equal(securityBefore.data.security.devices.filter((row) => row.current).length, 1);
    assert.equal(JSON.stringify(securityBefore.data.security).includes('device-12345678'), false);
    const secondDeviceRecord = securityBefore.data.security.devices.find((row) => !row.current);
    assert.ok(secondDeviceRecord?.id);

    // Multiple browser sessions on one device do not consume extra device slots and can be individually revoked.
    const extraSessionLogin = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.24' },
      body: extensionBody({ email, password: initialPassword, browserInstanceId: 'browser-extra-12345' }),
    });
    assert.equal(extraSessionLogin.response.status, 200);
    const extraToken = extraSessionLogin.data.sessionToken;
    const securityWithExtra = await jsonRequest(`${base}/api/v1/account/security`, { headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` } });
    const extraSession = securityWithExtra.data.security.sessions.find((row) => row.currentDevice && !row.current);
    assert.ok(extraSession);
    const revokeExtra = await jsonRequest(`${base}/api/v1/account/sessions/revoke`, {
      method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` }, body: { sessionId: extraSession.id },
    });
    assert.equal(revokeExtra.response.status, 200);
    const extraAfterRevoke = await jsonRequest(`${base}/api/v1/account/me`, { headers: { origin: ORIGIN, authorization: `Bearer ${extraToken}` } });
    assert.equal(extraAfterRevoke.response.status, 401);

    // A third device can replace an explicitly selected old device after password verification.
    const thirdBlocked = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.25' },
      body: extensionBody({ email, password: initialPassword, deviceId: 'device-33333333', browserInstanceId: 'browser-33333333' }),
    });
    assert.equal(thirdBlocked.response.status, 409);
    assert.equal(thirdBlocked.data.error.code, 'DEVICE_LIMIT');
    const replaceTarget = thirdBlocked.data.error.details.devices.find((row) => row.id === secondDeviceRecord.id);
    assert.ok(replaceTarget?.id, 'the explicitly selected second device must be offered for replacement');
    const thirdLogin = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.26' },
      body: extensionBody({
        email, password: initialPassword, deviceId: 'device-33333333', browserInstanceId: 'browser-33333333',
        replaceDeviceRecordIds: [replaceTarget.id],
      }),
    });
    assert.equal(thirdLogin.response.status, 200);
    const thirdToken = thirdLogin.data.sessionToken;
    const replacedOldSession = await jsonRequest(`${base}/api/v1/account/me`, { headers: { origin: ORIGIN, authorization: `Bearer ${secondToken}` } });
    assert.equal(replacedOldSession.response.status, 401);

    // The still-logged-in first device can release the new third device and immediately free its slot.
    const securityAfterReplace = await jsonRequest(`${base}/api/v1/account/security`, { headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` } });
    const thirdDevice = securityAfterReplace.data.security.devices.find((row) => !row.current);
    assert.ok(thirdDevice?.id);
    const releaseThird = await jsonRequest(`${base}/api/v1/account/devices/release`, {
      method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` }, body: { deviceRecordId: thirdDevice.id },
    });
    assert.equal(releaseThird.response.status, 200);
    assert.equal(releaseThird.data.security.devices.length, 1);
    const thirdAfterRelease = await jsonRequest(`${base}/api/v1/account/me`, { headers: { origin: ORIGIN, authorization: `Bearer ${thirdToken}` } });
    assert.equal(thirdAfterRelease.response.status, 401);

    // Current device cannot be accidentally released through the self-service endpoint.
    const currentDevice = releaseThird.data.security.devices.find((row) => row.current);
    const releaseCurrent = await jsonRequest(`${base}/api/v1/account/devices/release`, {
      method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` }, body: { deviceRecordId: currentDevice.id },
    });
    assert.equal(releaseCurrent.response.status, 409);
    assert.equal(releaseCurrent.data.error.code, 'CURRENT_DEVICE');

    // Configure encrypted SMTP credential and WeChat payment entry.
    const saveSettings = await jsonRequest(`${base}/admin/api/account/settings`, {
      method: 'PUT', headers: { cookie }, body: {
        free: { days: 7, maxDevices: 1, maxWindows: 1 },
        sessionDays: 30,
        smtp: {
          host: 'smtp.example.com', port: 465, secure: true, username: 'mailer@example.com',
          password: 'smtp-secret-should-not-be-plaintext', fromEmail: 'mailer@example.com', fromName: 'GPTWork',
        },
        paymentMethods: [
          { code: 'wechat', enabled: true, payUrl: 'https://pay.example.com/wechat#ignored', instructions: '付款后等待确认' },
          { code: 'alipay', enabled: false, payUrl: '', instructions: '' },
        ],
      },
    });
    assert.equal(saveSettings.response.status, 200);
    assert.equal(saveSettings.data.settings.smtp.passwordConfigured, true);
    assert.equal(saveSettings.data.settings.paymentMethods.find((item) => item.code === 'wechat').payUrl, 'https://pay.example.com/wechat');

    inspectDb = new DatabaseSync(dbPath);
    const smtpSecret = inspectDb.prepare(`SELECT ciphertext FROM secure_settings WHERE key='smtp_password'`).get();
    assert.ok(smtpSecret?.ciphertext);
    assert.equal(smtpSecret.ciphertext.includes('smtp-secret-should-not-be-plaintext'), false);
    assert.equal(inspectDb.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id).password_hash.includes(initialPassword), false);

    // Admin can configure paid user levels; client sees only upgrade levels and enabled payment methods.
    const planUpdate = await jsonRequest(`${base}/admin/api/account/plans/deep`, {
      method: 'PUT', headers: { cookie }, body: {
        name: '深度 Pro', priceCents: 1999, durationDays: 30, maxDevices: 1, maxWindows: 3,
        benefits: ['30 天深度用户', '1 台设备', '3 个同时窗口'], enabled: true,
      },
    });
    assert.equal(planUpdate.response.status, 200);

    const clientConfig = await jsonRequest(`${base}/api/v1/account/config`, { headers: { origin: ORIGIN } });
    const deep = clientConfig.data.plans.find((plan) => plan.code === 'deep');
    assert.equal(deep.priceCents, 1999);
    assert.equal(deep.limits.devices, 1);
    assert.equal(deep.limits.windows, 3);
    assert.deepEqual(clientConfig.data.paymentMethods.map((method) => method.code), ['wechat']);

    // User creates an upgrade order; admin marks paid; the user level becomes deep.
    const createOrder = await jsonRequest(`${base}/api/v1/account/orders`, {
      method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` }, body: { planCode: 'deep', paymentMethod: 'wechat' },
    });
    assert.equal(createOrder.response.status, 201);
    assert.equal(createOrder.data.order.amountCents, 1999);
    assert.equal(createOrder.data.order.payUrl, 'https://pay.example.com/wechat');
    assert.equal(createOrder.data.order.status, 'pending');
    assert.equal(createOrder.data.order.planSnapshot.name, '深度 Pro');
    assert.equal(createOrder.data.order.planSnapshot.maxDevices, 1);
    assert.equal(createOrder.data.order.planSnapshot.maxWindows, 3);

    // Existing orders must keep the purchased terms even if the administrator changes the plan before payment confirmation.
    const futurePlanUpdate = await jsonRequest(`${base}/admin/api/account/plans/deep`, {
      method: 'PUT', headers: { cookie }, body: {
        name: '深度 Future', priceCents: 2999, durationDays: 45, maxDevices: 1, maxWindows: 3,
        benefits: ['45 天深度用户', '1 台设备', '3 个同时窗口'], enabled: true,
      },
    });
    assert.equal(futurePlanUpdate.response.status, 200);

    const markPaid = await jsonRequest(`${base}/admin/api/account/orders/${createOrder.data.order.id}/mark-paid`, {
      method: 'POST', headers: { cookie }, body: {},
    });
    assert.equal(markPaid.response.status, 200);
    assert.equal(markPaid.data.order.status, 'paid');

    const meAfterMembership = await jsonRequest(`${base}/api/v1/account/me`, {
      headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` },
    });
    assert.equal(meAfterMembership.response.status, 200);
    assert.equal(meAfterMembership.data.account.level.code, 'deep');
    assert.equal(meAfterMembership.data.account.entitlement.source, 'level');
    // Per-user overrides intentionally remain stronger than the frozen purchased plan defaults.
    assert.equal(meAfterMembership.data.account.entitlement.limits.devices, 2);
    assert.equal(meAfterMembership.data.account.entitlement.limits.windows, 2);

    // Forgot-password does not reveal account existence, and reset revokes old sessions.
    const forgotUnknown = await jsonRequest(`${base}/api/v1/auth/forgot-password`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.30' }, body: extensionBody({ email: 'unknown@example.com' }),
    });
    assert.equal(forgotUnknown.response.status, 200);
    const forgotKnown = await jsonRequest(`${base}/api/v1/auth/forgot-password`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.31' }, body: extensionBody({ email }),
    });
    assert.equal(forgotKnown.response.status, 200);
    assert.equal(forgotKnown.data.message, forgotUnknown.data.message);

    const resetCode = latestCode(await testOutbox(base, cookie), email, 'reset_password');
    const reset = await jsonRequest(`${base}/api/v1/auth/reset-password`, {
      method: 'POST', headers: { origin: ORIGIN }, body: extensionBody({ email, code: resetCode, newPassword: resetPassword }),
    });
    assert.equal(reset.response.status, 200);

    const oldSession = await jsonRequest(`${base}/api/v1/account/me`, { headers: { origin: ORIGIN, authorization: `Bearer ${firstToken}` } });
    assert.equal(oldSession.response.status, 401);
    assert.equal(oldSession.data.error.code, 'AUTH_REQUIRED');

    const loginWithOldPassword = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.32' }, body: extensionBody({ email, password: initialPassword }),
    });
    assert.equal(loginWithOldPassword.response.status, 401);

    const newLogin = await jsonRequest(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.33' }, body: extensionBody({ email, password: resetPassword }),
    });
    assert.equal(newLogin.response.status, 200);
    const newToken = newLogin.data.sessionToken;

    // Account disable immediately revokes all sessions.
    const disable = await jsonRequest(`${base}/admin/api/account/users/${user.id}`, {
      method: 'PATCH', headers: { cookie }, body: { status: 'disabled' },
    });
    assert.equal(disable.response.status, 200);
    const disabledSession = await jsonRequest(`${base}/api/v1/account/me`, { headers: { origin: ORIGIN, authorization: `Bearer ${newToken}` } });
    assert.equal(disabledSession.response.status, 401);

    // Runtime logs never include raw credentials/codes/session tokens.
    const runtime = await jsonRequest(`${base}/admin/api/runtime-logs?limit=500`, { headers: { cookie } });
    assert.equal(runtime.response.status, 200);
    assert.ok(runtime.data.logs.some((entry) => entry.event === 'server_started'));
    const serializedRuntime = JSON.stringify(runtime.data.logs);
    for (const secret of [adminPassword, initialPassword, resetPassword, verifyCode, resetCode, firstToken, newToken, 'smtp-secret-should-not-be-plaintext']) {
      assert.equal(serializedRuntime.includes(secret), false, `runtime log leaked: ${secret.slice(0, 8)}`);
    }
    const rawRuntime = await readFile(runtimeLogPath, 'utf8');
    assert.equal(rawRuntime.includes(initialPassword), false);
    assert.equal(rawRuntime.includes(firstToken), false);
    assert.equal(rawRuntime.includes(verifyCode), false);

    // Existing update control-plane remains available.
    const updateInfo = await jsonRequest(`${base}/admin/api/update`, { headers: { cookie } });
    assert.equal(updateInfo.response.status, 200);
    assert.equal(updateInfo.data.ok, true);
    assert.equal(updateInfo.data.serverVersion, '0.2.0');
    const update = await jsonRequest(`${base}/admin/api/update`, { method: 'POST', headers: { cookie }, body: {} });
    assert.equal(update.response.status, 202);
    assert.equal(update.data.status.status, 'queued');
  } finally {
    inspectDb?.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
