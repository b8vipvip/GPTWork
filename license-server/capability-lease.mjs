import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

export const CAPABILITY_LEASE_VERSION = 1;
export const CAPABILITY_LEASE_AUDIENCE = 'gptwork-private-engine';
export const CAPABILITY_LEASE_DEFAULT_TTL_SECONDS = 300;
export const CAPABILITY_LEASE_FEATURES = Object.freeze([
  'evaluate_request',
  'evaluate_response',
  'evaluate_context',
]);

function encode(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
}

function requiredString(value, name, max = 256) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new Error(`Invalid capability lease ${name}`);
  return text;
}

function boundedStrings(values, name, { maxItems = 32, maxLength = 256 } = {}) {
  if (!Array.isArray(values) || values.length > maxItems) throw new Error(`Invalid capability lease ${name}`);
  return [...new Set(values.map((value) => requiredString(value, name, maxLength)))];
}

export function createCapabilityLeaseIssuer({
  privateKeyPem,
  issuer = 'https://gptlock.mv3.cn',
  ttlSeconds = CAPABILITY_LEASE_DEFAULT_TTL_SECONDS,
  now = () => Date.now(),
} = {}) {
  const pem = String(privateKeyPem || '').trim();
  if (!pem) throw new Error('GPTLOCK_CAPABILITY_LEASE_PRIVATE_KEY_PEM is required when capability lease issuance is enabled');
  const privateKey = createPrivateKey(pem.replace(/\\n/g, '\n'));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Capability lease signing key must be Ed25519');
  const publicKey = createPublicKey(privateKey);
  const lifetime = Number(ttlSeconds);
  if (!Number.isInteger(lifetime) || lifetime < 60 || lifetime > 900) throw new Error('Capability lease TTL must be between 60 and 900 seconds');
  const canonicalIssuer = requiredString(issuer, 'issuer', 512).replace(/\/$/, '');

  function issue({ subject, sessionId, deviceId, browserInstanceId, extensionId, features, windowKeys }) {
    const issuedAt = Math.floor(now() / 1000);
    const claims = {
      version: CAPABILITY_LEASE_VERSION,
      issuer: canonicalIssuer,
      audience: CAPABILITY_LEASE_AUDIENCE,
      subject: requiredString(subject, 'subject'),
      sessionId: requiredString(sessionId, 'sessionId'),
      deviceId: requiredString(deviceId, 'deviceId'),
      browserInstanceId: requiredString(browserInstanceId, 'browserInstanceId'),
      extensionId: requiredString(extensionId, 'extensionId', 64),
      features: boundedStrings(features, 'features', { maxItems: 16, maxLength: 64 }),
      windowKeys: boundedStrings(windowKeys, 'windowKeys', { maxItems: 64, maxLength: 256 }),
      issuedAt,
      notBefore: issuedAt - 5,
      expiresAt: issuedAt + lifetime,
      jti: randomBytes(18).toString('base64url'),
    };
    if (!claims.features.length || claims.features.some((feature) => !CAPABILITY_LEASE_FEATURES.includes(feature))) {
      throw new Error('Capability lease contains unsupported features');
    }
    const header = { alg: 'EdDSA', typ: 'GPTWORK-LEASE', kid: 'gptwork-lease-v1' };
    const signingInput = `${encode(header)}.${encode(claims)}`;
    const signature = sign(null, Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url');
    return {
      leaseToken: `${signingInput}.${signature}`,
      expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
      claims,
    };
  }

  function publicKeyPem() {
    return publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  return { issue, publicKeyPem };
}

// Test/deployment validation helper. The production private engine performs its own
// independent verification; the server must never use this function as authorization.
export function verifyCapabilityLeaseForTest(token, publicKeyPem) {
  const [headerPart, claimsPart, signaturePart, extra] = String(token || '').split('.');
  if (!headerPart || !claimsPart || !signaturePart || extra) return null;
  let header;
  let claims;
  try {
    header = decodeJson(headerPart);
    claims = decodeJson(claimsPart);
  } catch { return null; }
  if (header?.alg !== 'EdDSA' || header?.typ !== 'GPTWORK-LEASE' || header?.kid !== 'gptwork-lease-v1') return null;
  const key = createPublicKey(String(publicKeyPem || ''));
  const ok = verify(null, Buffer.from(`${headerPart}.${claimsPart}`, 'ascii'), key, Buffer.from(signaturePart, 'base64url'));
  return ok ? claims : null;
}
