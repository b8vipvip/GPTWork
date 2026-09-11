import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateGuard } from '../guard.js';
import { DEFAULT_POLICY, DEFAULT_SETTINGS } from '../policy.js';

const ENABLED_SETTINGS = Object.freeze({ ...DEFAULT_SETTINGS, enabled: true });

function state(patch = {}) {
  return {
    phase: 'initial',
    core: { connected: true, error: null },
    monitor: { attached: true, error: null },
    pageObservation: { model: 'gpt-5.6-sol', reasoning: 'high' },
    probeUsed: false,
    probeArmed: false,
    lastRequest: null,
    lastVerification: null,
    lastError: null,
    autoVerification: null,
    ...patch,
  };
}

function verifiedAuto(patch = {}) {
  return {
    running: false,
    completedAt: '2026-08-26T12:55:24.201Z',
    outcome: 'verified',
    responseModel: 'gpt-5.6-sol',
    responseReasoning: 'high',
    evidenceSource: 'network_response_metadata',
    ...patch,
  };
}

function confirmedMismatch(patch = {}) {
  return {
    model: 'gpt-5.5',
    reasoning: 'high',
    verdict: 'mismatch',
    reason: 'model_not_allowed',
    reasons: ['model_not_allowed'],
    verifiedAt: '2026-08-26T12:55:20.000Z',
    ...patch,
  };
}

test('normal enabled state is request-lock ready without a probe gate', () => {
  const guard = evaluateGuard({ state: state(), policy: DEFAULT_POLICY, settings: ENABLED_SETTINGS });
  assert.equal(guard.canSend, true);
  assert.equal(guard.allowKind, 'locked');
  assert.equal(guard.status, 'lock_ready');
});

test('page selection mismatch is warning-only because the formal request is locked later', () => {
  const guard = evaluateGuard({
    state: state({ pageObservation: { model: 'gpt-5.5', reasoning: 'high' } }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(guard.canSend, true);
  assert.equal(guard.allowKind, 'warning');
  assert.equal(guard.status, 'preflight_mismatch');
  assert.equal(guard.reason, 'page_selection_not_allowed');
});

test('missing page fields keep the network request lock ready', () => {
  const guard = evaluateGuard({
    state: state({ pageObservation: { model: null, reasoning: null } }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(guard.canSend, true);
  assert.equal(guard.allowKind, 'locked');
  assert.equal(guard.status, 'lock_ready');
  assert.equal(guard.reason, 'page_selection_missing');
});

test('waiting, unverified and verification errors do not interrupt chat', () => {
  for (const phase of ['waiting', 'unverified', 'error']) {
    const guard = evaluateGuard({ state: state({ phase }), policy: DEFAULT_POLICY, settings: ENABLED_SETTINGS });
    assert.equal(guard.canSend, true, phase);
  }
});

test('strict mode blocks only a confirmed response model mismatch for the latest request', () => {
  const guard = evaluateGuard({
    state: state({
      phase: 'mismatch',
      lastRequest: { capturedAt: '2026-08-26T12:55:18.000Z' },
      lastVerification: confirmedMismatch({ reasons: ['model_not_allowed', 'reasoning_missing'] }),
    }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(guard.canSend, false);
  assert.equal(guard.allowKind, 'blocked');
  assert.equal(guard.status, 'mismatch');
  assert.equal(guard.reason, 'model_not_allowed');
});

test('stale mismatch from an older turn cannot block a newer request', () => {
  const guard = evaluateGuard({
    state: state({
      phase: 'mismatch',
      lastRequest: { capturedAt: '2026-08-26T12:56:00.000Z' },
      lastVerification: confirmedMismatch({ verifiedAt: '2026-08-26T12:55:20.000Z' }),
    }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(guard.canSend, true);
  assert.equal(guard.allowKind, 'warning');
  assert.equal(guard.status, 'mismatch');
});

test('stale model_not_allowed reason cannot block when the verified model is now allowed', () => {
  const guard = evaluateGuard({
    state: state({
      phase: 'mismatch',
      lastRequest: { capturedAt: '2026-08-26T12:55:18.000Z' },
      lastVerification: confirmedMismatch({ model: 'gpt-5.6-sol' }),
    }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(guard.canSend, true);
  assert.equal(guard.status, 'mismatch');
});

test('uncorrelated mismatch evidence fails open instead of permanently blocking chat', () => {
  const guard = evaluateGuard({
    state: state({
      phase: 'mismatch',
      lastRequest: { capturedAt: '2026-08-26T12:55:18.000Z' },
      lastVerification: confirmedMismatch({ verifiedAt: undefined }),
    }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(guard.canSend, true);
  assert.equal(guard.status, 'mismatch');
});

test('reasoning-only mismatch remains warning-only even in strict mode', () => {
  const guard = evaluateGuard({
    state: state({
      phase: 'mismatch',
      lastVerification: { reason: 'reasoning_not_allowed', reasons: ['reasoning_not_allowed'] },
    }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(guard.canSend, true);
  assert.equal(guard.allowKind, 'warning');
});

test('verified response remains sendable', () => {
  const guard = evaluateGuard({ state: state({ phase: 'verified' }), policy: DEFAULT_POLICY, settings: ENABLED_SETTINGS });
  assert.equal(guard.canSend, true);
  assert.equal(guard.allowKind, 'locked');
  assert.equal(guard.status, 'verified');
});

test('completed network-backed auto verification survives later metadata-empty frames from the same turn', () => {
  const guard = evaluateGuard({
    state: state({
      phase: 'unverified',
      lastRequest: { capturedAt: '2026-08-26T12:55:18.264Z' },
      lastVerification: {
        verdict: 'unverified',
        reason: 'model_missing',
        reasons: ['model_missing', 'reasoning_missing'],
      },
      autoVerification: verifiedAuto(),
    }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(guard.canSend, true);
  assert.equal(guard.allowKind, 'locked');
  assert.equal(guard.status, 'verified');
});

test('sticky auto verification does not leak into a newer request', () => {
  const guard = evaluateGuard({
    state: state({
      phase: 'waiting',
      lastRequest: { capturedAt: '2026-08-26T12:56:10.000Z' },
      autoVerification: verifiedAuto(),
    }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(guard.status, 'waiting');
});

test('sticky auto verification requires complete allowed backend evidence', () => {
  const guard = evaluateGuard({
    state: state({
      phase: 'unverified',
      lastRequest: { capturedAt: '2026-08-26T12:55:18.264Z' },
      lastVerification: { reason: 'model_missing', reasons: ['model_missing'] },
      autoVerification: verifiedAuto({ responseReasoning: null }),
    }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(guard.status, 'unverified');
});

test('confirmed mismatch for the latest request overrides an earlier successful auto verification', () => {
  const guard = evaluateGuard({
    state: state({
      phase: 'mismatch',
      lastRequest: { capturedAt: '2026-08-26T12:55:18.264Z' },
      lastVerification: confirmedMismatch(),
      autoVerification: verifiedAuto(),
    }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(guard.canSend, false);
  assert.equal(guard.status, 'mismatch');
});

test('monitor or Native Core outage warns but does not block normal chat', () => {
  const monitor = evaluateGuard({
    state: state({ monitor: { attached: false, error: 'detached' } }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(monitor.canSend, true);
  assert.equal(monitor.status, 'monitor_offline');

  const core = evaluateGuard({
    state: state({ core: { connected: false, error: 'host missing' } }),
    policy: DEFAULT_POLICY,
    settings: ENABLED_SETTINGS,
  });
  assert.equal(core.canSend, true);
  assert.equal(core.status, 'core_offline');
});

test('response verification can be disabled while request locking remains active', () => {
  const guard = evaluateGuard({
    state: state(),
    policy: DEFAULT_POLICY,
    settings: { ...ENABLED_SETTINGS, networkVerificationEnabled: false },
  });
  assert.equal(guard.canSend, true);
  assert.equal(guard.allowKind, 'locked');
  assert.equal(guard.status, 'verification_disabled');
});

test('global disable bypasses enforcement and reports an explicit disabled state', () => {
  const guard = evaluateGuard({
    state: state({ core: { connected: false, error: 'host missing' } }),
    policy: DEFAULT_POLICY,
    settings: { ...DEFAULT_SETTINGS, enabled: false },
  });
  assert.equal(guard.canSend, true);
  assert.equal(guard.allowKind, 'disabled');
  assert.equal(guard.status, 'disabled');
  assert.equal(guard.reason, 'gptlock_disabled');
});
