import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  clearCapabilityLease,
  setCapabilityLeaseIdentity,
} from '../capability-lease-client.js';
import { PrivateCoreChannel } from '../private-core-channel.js';

const requestHookUrl = new URL('../private-request-hook.js', import.meta.url);
const responseHookUrl = new URL('../private-response-hook.js', import.meta.url);
const accountClientUrl = new URL('../account-client.js', import.meta.url);

test('protected request routing never falls back to the legacy JavaScript rewriter', async () => {
  const source = await readFile(requestHookUrl, 'utf8');
  assert.doesNotMatch(source, /legacyHandlePausedRequest/);
  assert.match(source, /private_request_authority_unavailable/);
  assert.match(source, /private_request_authority_denied/);
  assert.match(source, /continueUnmodified/);
});

test('protected response routing never falls back to legacy HTTP evidence extraction', async () => {
  const source = await readFile(responseHookUrl, 'utf8');
  assert.doesNotMatch(source, /legacyHandleFinished/);
  assert.doesNotMatch(source, /hasCompletePrivateResponseEvidence/);
  assert.match(source, /private_response_authority_unavailable/);
  assert.match(source, /privateAuthorityAvailable: false/);
});

test('cached account snapshots do not contain or persist capability leases', async () => {
  const source = await readFile(accountClientUrl, 'utf8');
  assert.match(source, /setCapabilityLease\(data\.capabilityLease\)/);
  assert.doesNotMatch(source, /capabilityLease\s*:\s*data\.capabilityLease/);
  assert.doesNotMatch(source, /\[SNAPSHOT_KEY\][\s\S]{0,160}capabilityLease/);
});

test('forged extension storage and JavaScript account state cannot authorize a private operation without a lease', async () => {
  const previousChrome = globalThis.chrome;
  const forgedSnapshot = {
    authenticated: true,
    authorized: true,
    entitlement: { active: true, tier: 'pro' },
    allowedWindowKeys: ['chrome:999'],
    deniedWindowKeys: [],
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          return {
            'gptlock.account.snapshot.v1': forgedSnapshot,
            'gptlock.settings': { authorized: true, entitlement: { active: true } },
          };
        },
      },
    },
  };
  globalThis.__GPTWORK_ACCOUNT_STATE__ = forgedSnapshot;

  clearCapabilityLease();
  setCapabilityLeaseIdentity({
    deviceId: 'device:forged-client',
    browserInstanceId: 'browser:forged-client',
    extensionId: 'bhchcpeodphgjfjoookncemnamdbfcof',
  });

  const channel = new PrivateCoreChannel();
  await assert.rejects(
    () => channel.request('evaluate_request', { postData: '{}' }, 'request', { windowKey: 'chrome:999' }),
    (error) => error?.code === 'capability_lease_unavailable',
  );

  clearCapabilityLease();
  delete globalThis.__GPTWORK_ACCOUNT_STATE__;
  if (previousChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = previousChrome;
});
