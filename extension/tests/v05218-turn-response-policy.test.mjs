import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { evaluateGuard } from '../guard.js';
import { DEFAULT_POLICY, DEFAULT_SETTINGS } from '../policy.js';

const [background, catalog, popup] = await Promise.all(
  ['background.js', 'model-catalog.js', 'popup.js']
    .map(name => readFile(new URL('../' + name, import.meta.url), 'utf8')),
);
const settings = { ...DEFAULT_SETTINGS, enabled: true };
const policy = { ...DEFAULT_POLICY, lockedModels: ['gpt-6', 'gpt-5.6-sol'] };

function state(selectionRevision, requestRevision) {
  return {
    phase: 'mismatch',
    selectionRevision,
    monitor: { attached: true },
    core: { connected: true },
    pageObservation: { model: 'gpt-6', reasoning: 'high' },
    lastRequest: {
      requestId: 'network-request-1',
      model: 'gpt-5.5',
      capturedAt: '2026-10-11T05:18:01.997Z',
      selectionRevision: requestRevision,
      policySnapshot: { ...policy, lockedModels: ['gpt-5.6-sol'] },
    },
    lastVerification: {
      requestId: 'cdp-12-network-request-1',
      model: 'gpt-5.5',
      verdict: 'mismatch',
      reason: 'model_not_allowed',
      reasons: ['model_not_allowed'],
      verifiedAt: '2026-10-11T05:18:28.946Z',
      evidenceSource: 'network_response_metadata',
    },
  };
}

test('same Picker A epoch: a confirmed served-model mismatch keeps strict guard', () => {
  const result = evaluateGuard({
    state: state(2, 2), policy, settings,
  });
  assert.equal(result.canSend, false);
  assert.equal(result.reason, 'model_not_allowed');
});

test('real GPT-5.5 to GPT-6 switch: old late response cannot block the next turn', () => {
  const result = evaluateGuard({
    state: state(3, 2), policy, settings,
  });
  assert.equal(result.canSend, true);
  assert.equal(result.allowKind, 'warning');
  assert.equal(result.status, 'unverified');
  assert.equal(result.reason, 'previous_request_mismatch_not_current_selection');
});

test('a new request in the current epoch still blocks if its own served model mismatches', () => {
  const result = evaluateGuard({
    state: state(3, 3), policy, settings,
  });
  assert.equal(result.canSend, false);
});

function responsePolicySnapshot(request, responseRequestId, currentPolicy) {
  const start = background.indexOf('  const requestPolicy = state.lastRequest?.requestId === evidenceRequestId');
  const end = background.indexOf('\n  if (normalPolicy.lockedModels.length === 0)', start);
  assert.ok(start > 0 && end > start, 'actual network response policy snapshot code must exist');
  const runtime = vm.createContext({
    state: { lastRequest: request },
    evidenceRequestId: responseRequestId,
    tabId: 12,
    normalizePolicy(value) { return value; },
    runtimePolicyForTabSync() { return currentPolicy; },
  });
  vm.runInContext(background.slice(start, end) + '\nglobalThis.resolved = normalPolicy;', runtime);
  return Array.from(runtime.resolved.lockedModels);
}

test('late response uses original request lock, not new Picker A lock', () => {
  const request = state(3, 2).lastRequest;
  assert.deepEqual(responsePolicySnapshot(request, 'network-request-1', { lockedModels: ['gpt-6'] }), ['gpt-5.6-sol']);
  assert.deepEqual(responsePolicySnapshot(request, 'another-request', { lockedModels: ['gpt-6'] }), ['gpt-6']);
  assert.match(background, /\}, normalPolicy\);\s*state\.lastVerification = result/);
  assert.match(background, /selectionRevision: state\.selectionRevision,\s*policySnapshot:/);
  assert.match(background, /state\.selectionRevision = \(state\.selectionRevision \|\| 0\) \+ 1/);
  assert.match(background, /state\.lastKnownPageModel = observedConcreteModel/);
});

function snapshot(stateValue) {
  const start = catalog.indexOf('  function modelSnapshot(state) {');
  const end = catalog.indexOf('\n  function rememberModels(candidates) {', start);
  assert.ok(start > 0 && end > start);
  const runtime = vm.createContext({
    currentPolicy: policy,
    trustedStatus: null,
    normalizeModelId(value) { return typeof value === 'string' ? value : null; },
    normalizeConcreteModelId(value) { return typeof value === 'string' ? value : null; },
    timestamp(value) {
      const parsed = Date.parse(value || '');
      return Number.isFinite(parsed) ? parsed : 0;
    },
    effectivePageObservation(value) { return value.pageObservation; },
    modelLabel(value) { return value; },
    responseAppliesToLatestRequest() { return true; },
  });
  vm.runInContext(catalog.slice(start, end) + '\nglobalThis.snapshot = modelSnapshot;', runtime);
  return runtime.snapshot(stateValue);
}

test('indicator identifies prior request/response and drops red alarm when page changed', () => {
  const current = snapshot(state(2, 2));
  assert.equal(current.response.mismatch, true);
  const previous = snapshot(state(3, 2));
  assert.equal(previous.response.mismatch, false);
  assert.equal(previous.response.historical, true);
  assert.equal(previous.response.confirmed, false);
  assert.match(previous.request.label, /上一轮请求/);
  assert.match(previous.response.label, /上一轮响应/);
  assert.match(popup, /上一轮响应（页面已切换）/);
});
