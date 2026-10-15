import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { rewriteConversationPostData } from '../network-evidence.js';

const [catalog, popup, content] = await Promise.all(
  ['model-catalog.js', 'popup.js', 'content.js']
    .map(name => readFile(new URL('../' + name, import.meta.url), 'utf8')),
);
const t0 = '2026-10-15T02:40:00.000Z';
const t1 = '2026-10-15T02:40:10.000Z';
const policy = { lockedModels: ['gpt-6'] };

function snapshot(state) {
  const start = catalog.indexOf('  function modelSnapshot(state) {');
  const end = catalog.indexOf('\n  function rememberModels(candidates) {', start);
  assert.ok(start >= 0 && end > start);
  const runtime = vm.createContext({
    currentPolicy: policy, trustedStatus: null,
    normalizeModelId(value) { return value || null; },
    normalizeConcreteModelId(value) { return value || null; },
    modelLabel(value) { return value; },
    effectivePageObservation(value) { return value?.pageObservation ?? null; },
    timestamp(value) {
      const t = Date.parse(value || '');
      return Number.isFinite(t) ? t : 0;
    },
    responseAppliesToLatestRequest() { return true; },
  });
  vm.runInContext(catalog.slice(start, end) + '\nglobalThis.snapshot = modelSnapshot;', runtime);
  return runtime.snapshot(state);
}

function pageRequest({ responseModel = 'gpt-6-thinking', responseRequestId = 'r1', verdict = 'mismatch' } = {}) {
  return {
    selectionRevision: 0,
    phase: verdict,
    pageObservation: {
      model: 'gpt-5.6-sol', reasoning: 'high',
      modelEvidenceSource: 'official-picker-a-checked',
    },
    lastRewrite: {
      fetchRequestId: 'fetch-1', capturedAt: t0,
      endpoint: '/backend-api/f/conversation',
      changed: true, error: null,
      modelBefore: 'gpt-5.6-sol', modelAfter: 'gpt-6',
    },
    lastRequest: {
      requestId: 'r1', capturedAt: t0,
      model: 'gpt-6', reasoning: 'high', selectionRevision: 0,
    },
    lastResponseEvidence: {
      requestId: responseRequestId, capturedAt: t1,
      evidenceSource: 'network_response_metadata',
      model: responseModel, reasoning: 'high',
      fields: { model: 'message.metadata.resolved_model_slug' },
      conflicts: { model: false, reasoning: false },
      bodyError: null,
    },
    lastVerification: {
      requestId: 'cdp-1-r1', verifiedAt: t1,
      model: responseModel, verdict,
      reasons: verdict === 'mismatch' ? ['model_not_allowed'] : [],
      evidenceSource: 'network_response_metadata',
    },
  };
}

test('a known but disallowed GPT-5.6 Sol page model is rewritten to explicit GPT-6 request lock', () => {
  const request = JSON.stringify({ model: 'gpt-5.6-sol-wm', messages: ['test'] });
  const result = rewriteConversationPostData(request, {
    lockedModels: ['gpt-6'],
    knownModels: ['gpt-5.6-sol', 'gpt-6'],
    allowedReasoningLevels: ['high'], preferredReasoning: 'high',
  });
  assert.equal(result.changed, true);
  assert.equal(result.modelBefore, 'gpt-5.6-sol');
  assert.equal(result.modelAfter, 'gpt-6');
  assert.equal(JSON.parse(result.postData).model, 'gpt-6');
  assert.deepEqual(JSON.parse(result.postData).messages, ['test']);
});

test('direct GPT-6 Thinking served response is shown despite failed lock verification', () => {
  const result = snapshot(pageRequest());
  assert.equal(result.page.id, 'gpt-5.6-sol');
  assert.match(result.page.label, /与已锁定请求不同/);
  assert.equal(result.request.id, 'gpt-6');
  assert.match(result.request.label, /锁定改写/);
  assert.equal(result.response.id, 'gpt-6-thinking');
  assert.match(result.response.label, /实际响应/);
  assert.equal(result.response.mismatch, true);
  assert.equal(result.response.confirmed, false);
});

test('even a response using the disallowed page model is reported as actually served', () => {
  const result = snapshot(pageRequest({ responseModel: 'gpt-5.6-sol' }));
  assert.equal(result.response.id, 'gpt-5.6-sol');
  assert.equal(result.response.mismatch, true);
  assert.equal(result.request.id, 'gpt-6');
});

test('direct model observation is visible without a policy verdict', () => {
  const state = pageRequest();
  state.phase = 'unverified';
  state.lastVerification = null;
  const result = snapshot(state);
  assert.equal(result.response.id, 'gpt-6-thinking');
  assert.equal(result.response.mismatch, false);
  assert.equal(result.response.confirmed, false);
});

test('failed policy does not promote contradictory, stale or unattributed response metadata', () => {
  const stale = pageRequest({ responseRequestId: 'different-request' });
  stale.lastVerification = null;
  assert.equal(snapshot(stale).response.id, null);
  const conflicted = pageRequest();
  conflicted.lastResponseEvidence.conflicts.model = true;
  conflicted.lastVerification = null;
  assert.equal(snapshot(conflicted).response.id, null);
});

test('popup prefers directly attributed response before policy verifier and discovery summary', () => {
  const begin = popup.indexOf('  const responseValue = observedResponse');
  const after = popup.indexOf('  const previousSelectionResponse', begin);
  assert.ok(begin > 0 && after > begin);
  const selection = popup.slice(begin, after);
  assert.match(selection, /observedResponse\.model/);
  assert.match(selection, /tab\?\.lastVerification\?\.model/);
  assert.ok(selection.indexOf('observedResponse.model') < selection.indexOf('tab?.lastVerification?.model'));
  assert.match(popup, /与锁定策略不一致/);
});

test('normal Chat remains observation-only: no background model-menu alignment', () => {
  assert.doesNotMatch(content, /scheduleAlign\(\)/);
  assert.match(content, /if \(!autoVerificationRunning\) return false/);
});
