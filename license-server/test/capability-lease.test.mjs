import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  CAPABILITY_LEASE_AUDIENCE,
  createCapabilityLeaseIssuer,
  verifyCapabilityLeaseForTest,
} from '../capability-lease.mjs';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const request = {
  subject: 'user:42',
  sessionId: 'session:12345678',
  deviceId: 'device:12345678',
  browserInstanceId: 'browser:12345678',
  extensionId: 'bhchcpeodphgjfjoookncemnamdbfcof',
  features: ['evaluate_request', 'evaluate_response', 'evaluate_context'],
  windowKeys: ['window:100', 'window:101'],
};

test('issuer signs a short-lived Ed25519 lease bound to server-authoritative identity', () => {
  const key = keys();
  const issuer = createCapabilityLeaseIssuer({ privateKeyPem: key.privateKeyPem, now: () => 2_000_000_000_000 });
  const issued = issuer.issue(request);
  const claims = verifyCapabilityLeaseForTest(issued.leaseToken, key.publicKeyPem);
  assert.equal(claims.version, 1);
  assert.equal(claims.audience, CAPABILITY_LEASE_AUDIENCE);
  assert.equal(claims.subject, request.subject);
  assert.equal(claims.deviceId, request.deviceId);
  assert.deepEqual(claims.windowKeys, request.windowKeys);
  assert.equal(claims.expiresAt - claims.issuedAt, 300);
  assert.match(issued.leaseToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('tampering with signed claims invalidates the lease', () => {
  const key = keys();
  const issuer = createCapabilityLeaseIssuer({ privateKeyPem: key.privateKeyPem });
  const issued = issuer.issue(request);
  const [header, payload, signature] = issued.leaseToken.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.deviceId = 'device:attacker';
  const tampered = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
  assert.equal(verifyCapabilityLeaseForTest(tampered, key.publicKeyPem), null);
});

test('wrong public key cannot validate a lease', () => {
  const signer = keys();
  const attacker = keys();
  const issued = createCapabilityLeaseIssuer({ privateKeyPem: signer.privateKeyPem }).issue(request);
  assert.equal(verifyCapabilityLeaseForTest(issued.leaseToken, attacker.publicKeyPem), null);
});

test('issuer rejects missing key, symmetric/wrong key types, unsupported features and unsafe ttl', () => {
  assert.throws(() => createCapabilityLeaseIssuer(), /PRIVATE_KEY_PEM/);
  const key = keys();
  assert.throws(() => createCapabilityLeaseIssuer({ privateKeyPem: key.privateKeyPem, ttlSeconds: 3600 }), /TTL/);
  const issuer = createCapabilityLeaseIssuer({ privateKeyPem: key.privateKeyPem });
  assert.throws(() => issuer.issue({ ...request, features: ['client_says_premium'] }), /unsupported features/);
  assert.throws(() => issuer.issue({ ...request, windowKeys: new Array(65).fill('window:x') }), /windowKeys/);
});

test('exported public key corresponds to the deployment-only signing key', () => {
  const key = keys();
  const issuer = createCapabilityLeaseIssuer({ privateKeyPem: key.privateKeyPem });
  const issued = issuer.issue(request);
  assert.ok(verifyCapabilityLeaseForTest(issued.leaseToken, issuer.publicKeyPem()));
  assert.doesNotMatch(issuer.publicKeyPem(), /PRIVATE KEY/);
});
