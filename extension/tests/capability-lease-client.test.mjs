import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityLeaseEnvelope,
  capabilityLeaseSnapshot,
  clearCapabilityLease,
  resetCapabilityLeaseForTest,
  setCapabilityLease,
  setCapabilityLeaseIdentity,
} from '../capability-lease-client.js';

test('opaque lease is forwarded byte-for-byte with local request identity', () => {
  resetCapabilityLeaseForTest();
  const token = 'opaque.header.payload.signature';
  const now = Date.now();
  setCapabilityLeaseIdentity({
    deviceId: 'device:12345678',
    browserInstanceId: 'browser:12345678',
    extensionId: 'bhchcpeodphgjfjoookncemnamdbfcof',
  });
  setCapabilityLease({
    leaseToken: token,
    expiresAt: new Date(now + 60_000).toISOString(),
    windowKeys: ['chrome:100'],
  });
  const envelope = capabilityLeaseEnvelope('chrome:100', now);
  assert.equal(envelope.capabilityLease, token);
  assert.deepEqual(envelope.leaseBinding, {
    deviceId: 'device:12345678',
    browserInstanceId: 'browser:12345678',
    extensionId: 'bhchcpeodphgjfjoookncemnamdbfcof',
    windowKey: 'chrome:100',
  });
  assert.equal(capabilityLeaseSnapshot(now).leaseReady, true);
});

test('missing, expired and wrong-window leases fail before private transport', () => {
  resetCapabilityLeaseForTest();
  const now = Date.now();
  setCapabilityLeaseIdentity({
    deviceId: 'device:12345678',
    browserInstanceId: 'browser:12345678',
    extensionId: 'bhchcpeodphgjfjoookncemnamdbfcof',
  });
  assert.throws(() => capabilityLeaseEnvelope('chrome:100', now), /missing or expired/);
  setCapabilityLease({
    leaseToken: 'opaque-token',
    expiresAt: new Date(now + 4_000).toISOString(),
    windowKeys: ['chrome:100'],
  });
  assert.throws(() => capabilityLeaseEnvelope('chrome:100', now), /missing or expired/);
  setCapabilityLease({
    leaseToken: 'opaque-token',
    expiresAt: new Date(now + 60_000).toISOString(),
    windowKeys: ['chrome:100'],
  });
  assert.throws(() => capabilityLeaseEnvelope('chrome:101', now), /does not admit this window/);
  clearCapabilityLease();
  assert.equal(capabilityLeaseSnapshot(now).leaseReady, false);
});
