import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityLeaseStore } from '../capability-lease-client.js';

test('opaque lease is forwarded byte-for-byte with local request identity', () => {
  const store = createCapabilityLeaseStore();
  const token = 'opaque.header.payload.signature';
  const now = Date.now();
  store.setIdentity({
    deviceId: 'device:12345678',
    browserInstanceId: 'browser:12345678',
    extensionId: 'bhchcpeodphgjfjoookncemnamdbfcof',
  });
  store.setLease({
    leaseToken: token,
    expiresAt: new Date(now + 60_000).toISOString(),
    windowKeys: ['chrome:100'],
  });
  const envelope = store.envelope('chrome:100', now);
  assert.equal(envelope.capabilityLease, token);
  assert.deepEqual(envelope.leaseBinding, {
    deviceId: 'device:12345678',
    browserInstanceId: 'browser:12345678',
    extensionId: 'bhchcpeodphgjfjoookncemnamdbfcof',
    windowKey: 'chrome:100',
  });
});

test('missing, expired and wrong-window leases fail before private transport', () => {
  const store = createCapabilityLeaseStore();
  const now = Date.now();
  store.setIdentity({
    deviceId: 'device:12345678',
    browserInstanceId: 'browser:12345678',
    extensionId: 'bhchcpeodphgjfjoookncemnamdbfcof',
  });
  assert.throws(() => store.envelope('chrome:100', now), /missing or expired/);
  store.setLease({
    leaseToken: 'opaque-token',
    expiresAt: new Date(now + 4_000).toISOString(),
    windowKeys: ['chrome:100'],
  });
  assert.throws(() => store.envelope('chrome:100', now), /missing or expired/);
  store.setLease({
    leaseToken: 'opaque-token',
    expiresAt: new Date(now + 60_000).toISOString(),
    windowKeys: ['chrome:100'],
  });
  assert.throws(() => store.envelope('chrome:101', now), /does not admit this window/);
  store.clearLease();
  assert.throws(() => store.envelope('chrome:100', now), /missing or expired/);
});
