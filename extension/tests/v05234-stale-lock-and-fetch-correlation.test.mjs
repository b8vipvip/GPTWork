import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { evaluateGuard } from '../guard.js';
import { modelLockFamilyId, modelMatchesLock, normalizeConcreteModelId } from '../policy.js';
import { ForwardedRequestLedger, withForwardedRequestEvidence } from '../request-evidence-correlation.js';

const [tabFeature, background, catalog, popup] = await Promise.all(
  ['tab-feature-runtime.js', 'background.js', 'model-catalog.js', 'popup.js']
    .map((name) => readFile(new URL('../' + name, import.meta.url), 'utf8')),
);
const oldRequest = {
  requestId: '1768.11467',
  capturedAt: '2026-10-15T13:19:19.571Z',
  selectionRevision: 0,
  model: 'gpt-6-thinking',
  policySnapshot: {
    lockedModels: ['gpt-5.6-sol'],
    allowedReasoningLevels: ['medium', 'high', 'extra-high'],
    strictMode: true,
  },
};
const response = {
  requestId: 'cdp-124173819-1768.11467',
  model: 'gpt-6',
  reasoning: null,
  verdict: 'mismatch',
  reason: 'model_not_allowed',
  reasons: ['model_not_allowed', 'reasoning_missing'],
  evidenceSource: 'network_response_metadata',
  verifiedAt: '2026-10-15T13:19:54.664Z',
};
const state = {
  phase: 'mismatch',
  selectionRevision: 0,
  pageObservation: { model: 'gpt-6', reasoning: 'high' },
  lastRequest: oldRequest,
  lastVerification: response,
  monitor: { attached: true },
  core: { connected: true },
};
const settings = { enabled: true, networkVerificationEnabled: true };

test('21:19 old Sol request mismatch is real, but must not block 21:25 GPT-6 lock', () => {
  const sol = evaluateGuard({
    state, policy: { lockedModels: ['gpt-5.6-sol'], allowedReasoningLevels: ['high'], strictMode: true }, settings,
  });
  assert.equal(sol.canSend, false, 'the original Sol request mismatch remains auditable and strict');
  assert.equal(sol.reason, 'model_not_allowed');
  const gpt6 = evaluateGuard({
    state, policy: { lockedModels: ['gpt-6'], allowedReasoningLevels: ['high'], strictMode: true }, settings,
  });
  assert.equal(gpt6.canSend, true);
  assert.equal(gpt6.status, 'unverified');
  assert.equal(gpt6.reason, 'previous_request_policy_changed');
  assert.equal(state.lastVerification.model, 'gpt-6', 'raw response proof is not erased');
  assert.equal(state.lastVerification.reasoning, null, 'missing reasoning is not invented');
});

test('a newly changed lock never retroactively blocks the response to a prior allowed lock', () => {
  const formerlyAllowed = {
    ...state,
    lastRequest: { ...oldRequest, policySnapshot: { ...oldRequest.policySnapshot, lockedModels: ['gpt-6'] } },
    lastVerification: { ...response, model: 'gpt-5.5' },
  };
  const changed = evaluateGuard({
    state: formerlyAllowed,
    policy: { lockedModels: ['gpt-5.6-sol'], allowedReasoningLevels: ['high'], strictMode: true },
    settings,
  });
  assert.equal(changed.canSend, true);
  assert.equal(changed.reason, 'previous_request_policy_changed');
});

test('same request policy identity still blocks, including raw GPT-6 Thinking alias', () => {
  const request = {
    ...oldRequest,
    policySnapshot: { ...oldRequest.policySnapshot, lockedModels: ['gpt-6-thinking'] },
  };
  const bad = evaluateGuard({
    state: { ...state, lastRequest: request, lastVerification: { ...response, model: 'gpt-5.5' } },
    policy: { lockedModels: ['gpt-6'], allowedReasoningLevels: ['high'], strictMode: true },
    settings,
  });
  assert.equal(bad.canSend, false);
  assert.equal(modelMatchesLock('gpt-6-thinking', 'gpt-6'), true);
});

test('only the canonical policy is used for the actual lock, not the legacy selection mirror', () => {
  assert.match(tabFeature, /const allowed = normalizeModels\(basePolicy\.lockedModels\)/);
  assert.match(tabFeature, /active\.push\(\.\.\.normalizeModels\(basePolicy\.lockedModels\)\)/);
  assert.doesNotMatch(tabFeature, /modelLockSelection\.length \? modelLockSelection : normalizeModels\(basePolicy\.lockedModels\)/);
  assert.match(popup, /policy\.lockedModels/);
});

test('terminal Fetch is correlated across tab state resets and cannot leak to unrelated requests', () => {
  const ledger = new ForwardedRequestLedger({ ttlMs: 60_000, maxEntries: 2 });
  const rewrite = {
    endpoint: '/backend-api/f/conversation',
    requestId: '1768.11467',
    fetchRequestId: 'interception-job-20701.0',
    changed: true,
    modelBefore: 'gpt-6-thinking',
    modelAfter: 'gpt-5.6-sol',
    transportModelAfter: 'gpt-5.6-sol-wm',
    policySnapshot: oldRequest.policySnapshot,
  };
  assert.equal(ledger.remember(124173819, rewrite, 1000), true);
  // The per-conversation tab state was recreated after / -> /c/:id navigation.
  const recreated = { lastRequest: null, lastRewrite: null };
  const joined = withForwardedRequestEvidence(oldRequest, ledger.find(124173819, oldRequest.requestId, 2000));
  recreated.lastRequest = joined;
  assert.equal(joined.model, 'gpt-5.6-sol');
  assert.equal(joined.forwardedFetchRequestId, 'interception-job-20701.0');
  assert.deepEqual(joined.policySnapshot.lockedModels, ['gpt-5.6-sol']);
  assert.equal(joined.observedModel, 'gpt-6-thinking');
  assert.equal(ledger.find(124173918, '1768.11467', 2000), null);
  assert.equal(ledger.find(124173819, 'different', 2000), null);
  assert.equal(ledger.remember(124173819, { ...rewrite, requestId: null }, 2000), false);
  assert.equal(ledger.remember(124173819, { ...rewrite, error: 'continue_failed' }, 2000), false);
  assert.equal(ledger.find(124173819, oldRequest.requestId, 61_001), null);
  assert.match(background, /forwardedRequestLedger\.find\(tabId, request\.requestId\)/);
  assert.match(background, /forwardedRequestLedger\.remember\(tabId, state\.lastRewrite\)/);
});

test('floating model and popup mark prior policy response as history rather than current red alarm', () => {
  const begin = catalog.indexOf('  function modelSnapshot(state) {');
  const end = catalog.indexOf('\n  function rememberModels(candidates) {', begin);
  assert.ok(begin >= 0 && end > begin);
  const context = vm.createContext({
    currentPolicy: { lockedModels: ['gpt-6'] },
    trustedStatus: null,
    normalizeConcreteModelId,
    normalizeModelId: normalizeConcreteModelId,
    modelLockFamilyId,
    modelLabel: (value) => value,
    effectivePageObservation: (value) => value?.pageObservation ?? null,
    responseAppliesToLatestRequest: () => true,
    timestamp: (value) => Date.parse(value || '') || 0,
  });
  vm.runInContext(catalog.slice(begin, end) + '\nglobalThis.modelSnapshot = modelSnapshot;', context);
  const snap = context.modelSnapshot({
    ...state,
    guard: { canSend: true, reason: 'previous_request_policy_changed' },
    lastResponseEvidence: {
      requestId: oldRequest.requestId,
      capturedAt: '2026-10-15T13:19:54.664Z',
      evidenceSource: 'network_response_metadata',
      model: 'gpt-6',
      reasoning: null,
      fields: { model: 'message.metadata.resolved_model_slug' },
      conflicts: { model: false },
    },
  });
  assert.equal(snap.response.mismatch, false);
  assert.equal(snap.response.historical, true);
  assert.match(snap.response.label, /上一轮响应/);
  assert.match(popup, /previous_request_policy_changed/);
  assert.match(popup, /上一轮锁定策略下的响应/);
});
