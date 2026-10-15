import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { withForwardedRequestEvidence } from '../request-evidence-correlation.js';
import { modelLockFamilyId, modelMatchesLock, normalizeModelId, normalizeConcreteModelId } from '../policy.js';

const initial = {
  requestId: '15316.5513',
  model: 'gpt-5.6-thinking',
  reasoning: 'high',
  capturedAt: '2026-10-15T07:40:49.850Z',
  policySnapshot: { lockedModels: ['gpt-6'] },
};
const forwarded = {
  requestId: '15316.5513',
  fetchRequestId: 'interception-job-11827.0',
  endpoint: '/backend-api/f/conversation',
  reason: 'rewritten',
  changed: true,
  error: null,
  modelBefore: 'gpt-5.6-thinking',
  modelAfter: 'gpt-6',
  transportModelAfter: 'gpt-6',
  reasoningAfter: 'high',
};

test('real 2026-10-15 request reconciles Fetch.continueRequest with pre-Fetch Network evidence', () => {
  const result = withForwardedRequestEvidence(initial, forwarded);
  assert.equal(result.model, 'gpt-6');
  assert.equal(result.observedModel, 'gpt-5.6-thinking');
  assert.equal(result.requestEvidenceSource, 'fetch_continued');
  assert.equal(result.forwardedFetchRequestId, forwarded.fetchRequestId);
  assert.equal(result.requestRewritten, true);
  assert.deepEqual(result.policySnapshot.lockedModels, ['gpt-6']);
  const changedDuringDispatch = withForwardedRequestEvidence(
    { ...initial, policySnapshot: { lockedModels: ['gpt-5.6-sol', 'gpt-6'] } },
    { ...forwarded, policySnapshot: { lockedModels: ['gpt-6'] } },
  );
  assert.deepEqual(changedDuringDispatch.policySnapshot.lockedModels, ['gpt-6'],
    'the lock at terminal Fetch interception must survive a later UI policy change');
  assert.strictEqual(withForwardedRequestEvidence(result, forwarded), result);
});

test('only matching formal successful Fetch IDs override a request observation', () => {
  for (const broken of [
    { ...forwarded, requestId: 'different-request' },
    { ...forwarded, requestId: null },
    { ...forwarded, fetchRequestId: null },
    { ...forwarded, endpoint: '/backend-api/conversations' },
    { ...forwarded, error: 'continue_failed' },
    { ...forwarded, modelAfter: null },
  ]) assert.strictEqual(withForwardedRequestEvidence(initial, broken), initial);
  assert.strictEqual(withForwardedRequestEvidence(null, forwarded), null);
});

test('official GPT-5.6 Sol picker and GPT-5-6-thinking transport share only lock identity', () => {
  assert.equal(normalizeModelId('gpt-5-6-thinking'), 'gpt-5.6-thinking');
  assert.equal(modelLockFamilyId('gpt-5-6-thinking'), 'gpt-5.6-sol');
  assert.equal(modelMatchesLock('gpt-5.6-sol', 'gpt-5-6-thinking'), true);
  assert.equal(modelMatchesLock('gpt-5.6-sol', 'gpt-5.6'), true);
  assert.equal(modelMatchesLock('gpt-6', 'gpt-5-6-thinking'), false);
  assert.equal(modelMatchesLock('gpt-5.6-terra', 'gpt-5-6-thinking'), false);
});

test('official Picker A GPT-5.6 plain label means Sol, without changing raw request identity', async () => {
  const source = await readFile(new URL('../page-model-evidence.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const parser = context.__GPTLOCK_PAGE_MODEL_EVIDENCE__;
  assert.equal(parser.modelFromText('GPT-5.6'), 'gpt-5.6-sol');
  assert.equal(parser.modelFromText('GPT-5.6 Sol'), 'gpt-5.6-sol');
  assert.equal(parser.modelFromText('GPT-6'), 'gpt-6');
});

test('floating 锁定模型 shows forwarded GPT-6, not observed GPT-5.6, while response stays unverified', async () => {
  const source = await readFile(new URL('../model-catalog.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function modelSnapshot(state) {');
  const end = source.indexOf('\n  function rememberModels(candidates) {', start);
  const context = vm.createContext({
    currentPolicy: { lockedModels: ['gpt-6'] },
    trustedStatus: null,
    normalizeModelId, normalizeConcreteModelId,
    modelLabel(value) { return value; },
    effectivePageObservation(state) { return state.pageObservation || null; },
    responseAppliesToLatestRequest() { return false; },
    timestamp(value) { return Date.parse(value || '') || 0; },
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.snapshot = modelSnapshot;', context);
  const snapshot = context.snapshot({
    lastRequest: withForwardedRequestEvidence(initial, forwarded),
    lastRewrite: { ...forwarded, capturedAt: initial.capturedAt },
    phase: 'waiting',
    lastResponseEvidence: null,
    lastVerification: null,
  });
  assert.equal(snapshot.request.id, 'gpt-6');
  assert.match(snapshot.request.label, /锁定改写/);
  assert.equal(snapshot.response.id, null);
  assert.equal(snapshot.response.status, 'waiting');
});

test('floating Sol family matches observed gpt-5.6-thinking when allowed', async () => {
  const source = await readFile(new URL('../model-catalog.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function modelSnapshot(state) {');
  const end = source.indexOf('\n  function rememberModels(candidates) {', start);
  const context = vm.createContext({
    currentPolicy: { lockedModels: ['gpt-5.6-sol'] },
    trustedStatus: null,
    normalizeModelId, normalizeConcreteModelId,
    modelLabel(value) { return value; },
    effectivePageObservation(state) { return state.pageObservation || null; },
    responseAppliesToLatestRequest() { return false; },
    timestamp(value) { return Date.parse(value || '') || 0; },
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.snapshot = modelSnapshot;', context);
  const snap = context.snapshot({
    lastRequest: { ...initial, policySnapshot: { lockedModels: ['gpt-5.6-sol'] } },
    phase: 'waiting',
  });
  assert.equal(snap.request.id, 'gpt-5.6-sol');
  assert.doesNotMatch(snap.request.label, /不符合锁定/);
});
