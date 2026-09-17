const EXPIRY_SAFETY_MS = 5_000;

let identity = null;
let lease = null;

function required(value, name, max = 256) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new TypeError(`invalid capability lease ${name}`);
  return text;
}

export function setCapabilityLeaseIdentity(value = {}) {
  identity = {
    deviceId: required(value.deviceId, 'deviceId'),
    browserInstanceId: required(value.browserInstanceId, 'browserInstanceId'),
    extensionId: required(value.extensionId, 'extensionId', 64),
  };
  return { ...identity };
}

export function setCapabilityLease(value) {
  if (!value?.leaseToken || !value?.expiresAt) {
    lease = null;
    return null;
  }
  const expiresAtMs = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAtMs)) throw new TypeError('invalid capability lease expiry');
  const windowKeys = [...new Set(Array.isArray(value.windowKeys)
    ? value.windowKeys.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 256).slice(0, 64)
    : [])];
  lease = {
    leaseToken: required(value.leaseToken, 'token', 16_384),
    expiresAtMs,
    windowKeys,
  };
  return { expiresAt: new Date(expiresAtMs).toISOString(), windowKeys: [...windowKeys] };
}

export function clearCapabilityLease() {
  lease = null;
}

export function capabilityLeaseEnvelope(windowKey, nowMs = Date.now()) {
  if (!identity) {
    const error = new Error('Capability lease identity is unavailable');
    error.code = 'capability_lease_identity_unavailable';
    throw error;
  }
  if (!lease || lease.expiresAtMs <= nowMs + EXPIRY_SAFETY_MS) {
    const error = new Error('Capability lease is missing or expired');
    error.code = 'capability_lease_unavailable';
    throw error;
  }
  const key = required(windowKey, 'windowKey');
  if (!lease.windowKeys.includes(key)) {
    const error = new Error('Capability lease does not admit this window');
    error.code = 'capability_lease_window_denied';
    throw error;
  }
  return {
    capabilityLease: lease.leaseToken,
    leaseBinding: { ...identity, windowKey: key },
  };
}

export function capabilityLeaseSnapshot(nowMs = Date.now()) {
  return {
    identityReady: Boolean(identity),
    leaseReady: Boolean(lease && lease.expiresAtMs > nowMs + EXPIRY_SAFETY_MS),
    expiresAt: lease ? new Date(lease.expiresAtMs).toISOString() : null,
    windowKeys: lease ? [...lease.windowKeys] : [],
  };
}

export function resetCapabilityLeaseForTest() {
  identity = null;
  lease = null;
}
