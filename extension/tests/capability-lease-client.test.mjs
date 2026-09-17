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

test.beforeEach(() => resetCapabilityLeaseForTest());

test('opaque lease is forwarded byte-for-byte with local request identity', () => {
  const token = 'opaque.header.payload.signature';
  setCapabilityLeaseIdentity({
    deviceId: 'device:12345678',
    browserInstanceId: 'browser:12345678',
    extensionId: 'bhchcpeodphgjfjoookncemnamdbfcof',
  });
  setCapabilityLease({
    leaseToken: token,
    expiresAt: new Date(2_000_000).toISOString(),
    windowKeys: ['chrome:100'],
  });
  const envelope = capabilityLeaseEnvelope('chrome:100', 1_000_000);
  assert.equal(envelope.capabilityLease, token);
  assert.deepEqual(envelope.leaseBinding, {
    deviceId: 'device:12345678',
    browserInstanceId: 'browser:12345678',
    extensionId: 'bhchcpeodphgjfjoookncemnamdbfcof',
    windowKey: 'chrome:100',
  });
  assert.equal(capabilityLeaseSnapshot(1_000_000).leaseReady, true);
});

test('missing, expired and wrong-window leases fail before private transport', () => {
  setCapabilityLeaseIdentity({
    deviceId: 'device:12345678',
    browserInstanceId: 'browser:12345678',
    extensionId: 'bhchcpeodphgjfjoookncemnamdbfcof',
  });
  assert.throws(() => capabilityLeaseEnvelope('chrome:100', 1_000_000), /missing or expired/);
  setCapabilityLease({
    leaseToken: 'opaque-token',
    expiresAt: new Date(1_004_000).toISOString(),
    windowKeys: ['chrome:100'],
  });
  assert.throws(() => capabilityLeaseEnvelope('chrome:100', 1_000_000), /missing or expired/);
  setCapabilityLease({
    leaseToken: 'opaque-token',
    expiresAt: new Date(2_000_000).toISOString(),
    windowKeys: ['chrome:100'],
  });
  assert.throws(() => capabilityLeaseEnvelope('chrome:101', 1_000_000), /does not admit this window/);
  clearCapabilityLease();
  assert.equal(capabilityLeaseSnapshot(1_000_000).leaseReady, false);
});
