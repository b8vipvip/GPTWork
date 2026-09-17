import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createAccountSystem as createBaseAccountSystem } from './account-system-base.mjs';
import {
  CAPABILITY_LEASE_DEFAULT_TTL_SECONDS,
  CAPABILITY_LEASE_FEATURES,
  createCapabilityLeaseIssuer,
} from './capability-lease.mjs';

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function bearer(req) {
  const value = String(req?.headers?.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function createAccountSystem(options) {
  const env = options?.env || process.env;
  const leaseEnabled = enabled(env.GPTLOCK_CAPABILITY_LEASE_ENABLED);
  const leaseIssuer = leaseEnabled
    ? createCapabilityLeaseIssuer({
      privateKeyPem: env.GPTLOCK_CAPABILITY_LEASE_PRIVATE_KEY_PEM,
      issuer: options?.publicOrigin || env.GPTLOCK_LICENSE_PUBLIC_ORIGIN || 'https://gptlock.mv3.cn',
      ttlSeconds: Number(env.GPTLOCK_CAPABILITY_LEASE_TTL_SECONDS || CAPABILITY_LEASE_DEFAULT_TTL_SECONDS),
    })
    : null;
  const requestContext = new AsyncLocalStorage();
  const baseJson = options.json;

  function leaseForHeartbeat(body, req) {
    if (!leaseIssuer || body?.ok !== true || body?.authorized !== true || body?.account?.entitlement?.active !== true) {
      return null;
    }
    const token = bearer(req);
    if (!token) return null;
    const session = options.db.prepare(`SELECT id,user_id,device_id,browser_instance_id,extension_id,expires_at
      FROM user_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?`).get(sha256(token), new Date().toISOString());
    if (!session || Number(body?.account?.user?.id) !== Number(session.user_id)) return null;
    const windowKeys = [...new Set(Array.isArray(body.allowedWindowKeys)
      ? body.allowedWindowKeys.filter((value) => typeof value === 'string' && value.length > 0).slice(0, 64)
      : [])];
    if (!windowKeys.length) return null;
    const issued = leaseIssuer.issue({
      subject: `user:${session.user_id}`,
      sessionId: `session:${session.id}`,
      deviceId: session.device_id,
      browserInstanceId: session.browser_instance_id,
      extensionId: session.extension_id,
      features: CAPABILITY_LEASE_FEATURES,
      windowKeys,
    });
    return {
      leaseToken: issued.leaseToken,
      expiresAt: issued.expiresAt,
      windowKeys,
    };
  }

  const wrappedJson = (res, status, body, extra = {}) => {
    const context = requestContext.getStore();
    if (context?.url?.pathname === '/api/v1/account/heartbeat' && status === 200) {
      body = { ...body, capabilityLease: leaseForHeartbeat(body, context.req) };
    }
    return baseJson(res, status, body, extra);
  };

  const base = createBaseAccountSystem({ ...options, json: wrappedJson });
  return {
    ...base,
    handleApi(req, res, url, cors) {
      return requestContext.run({ req, url }, () => base.handleApi(req, res, url, cors));
    },
  };
}
