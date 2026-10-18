import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { classifyResponseModelIdentity } from '../response-model-identity.js';
import { extractResponseEvidence } from '../network-evidence.js';

const [background, catalog] = await Promise.all(
  ['background.js', 'model-catalog.js']
    .map((name) => readFile(new URL('../' + name, import.meta.url), 'utf8')),
);

test('bare GPT-6 response to an Astra transport request is unresolved, not confirmed or definitively mismatched', () => {
  const result = classifyResponseModelIdentity({
    requestModel: 'gpt-6-astra-wm',
    responseModel: 'gpt-6',
    responseField: 'v.message.metadata.resolved_model_slug',
    terminalEvent: 'loadingFailed',
    networkError: 'net::ERR_ABORTED',
  });
  assert.equal(result.status, 'family_only');
  assert.equal(result.requestedModel, 'gpt-6-astra');
  assert.equal(result.observedModel, 'gpt-6');
  assert.equal(result.variantConfirmed, false);
  assert.equal(result.definitiveMismatch, false);
  assert.equal(result.incompleteStream, true);
});

test('exact variant is distinct from family-only and a different complete variant', () => {
  assert.equal(classifyResponseModelIdentity({
    requestModel: 'gpt-6-astra', responseModel: 'gpt-6-astra',
  }).status, 'exact');
  assert.equal(classifyResponseModelIdentity({
    requestModel: 'gpt-6-astra', responseModel: 'gpt-6-sol',
  }).status, 'different');
  assert.equal(classifyResponseModelIdentity({
    requestModel: 'gpt-6-astra', responseModel: 'gpt-5.6-sol',
  }).status, 'different');
  assert.equal(classifyResponseModelIdentity({
    requestModel: 'gpt-6-astra', responseModel: 'gpt-6-sol',
    terminalEvent: 'loadingFailed', networkError: 'net::ERR_ABORTED',
  }).status, 'provisional_difference');
});

test('missing or unpaired response does not become an inferred Astra confirmation', () => {
  assert.equal(classifyResponseModelIdentity({
    requestModel: 'gpt-6-astra',
  }).status, 'missing');
  assert.equal(classifyResponseModelIdentity({
    responseModel: 'gpt-6',
  }).status, 'unpaired');
});

test('non-serving model_slug is logged separately and cannot override served-model authority', () => {
  const body = 'data: ' + JSON.stringify({
    message: { metadata: {
      model_slug: 'gpt-6-astra-wm',
      default_model_slug: 'gpt-5.6-sol',
      resolved_model_slug: 'gpt-6',
      thinking_effort: 'high',
    } },
  }) + '\n\n';
  const result = extractResponseEvidence({ body, mimeType: 'text/event-stream' });
  assert.equal(result.model, 'gpt-6');
  assert.equal(result.fields.model, 'v.message.metadata.resolved_model_slug'.replace(/^v\./, 'message.'));
  assert.ok(result.diagnostics.contextModelCandidateValues.includes('gpt-6-astra'));
  assert.ok(result.diagnostics.defaultModelCandidateValues.includes('gpt-5.6-sol'));
  assert.deepEqual(result.diagnostics.modelCandidateValues, ['gpt-6']);
});

function snapshot(state) {
  const start = catalog.indexOf('  function modelSnapshot(state) {');
  const end = catalog.indexOf('\n  function rememberModels(candidates) {', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    currentPolicy: { lockedModels: ['gpt-6-astra'] },
    trustedStatus: null,
    normalizeModelId(value) { return value || null; },
    normalizeConcreteModelId(value) { return value || null; },
    modelLabel(value) { return value; },
    effectivePageObservation(value) { return value?.pageObservation || null; },
    timestamp(value) { const date = Date.parse(value || ''); return Number.isFinite(date) ? date : 0; },
    responseAppliesToLatestRequest() { return true; },
  });
  vm.runInContext(catalog.slice(start, end) + '\nglobalThis.snapshot = modelSnapshot;', context);
  return context.snapshot(state);
}

test('a new Fetch rewrite hides old response even before formal Network request callback', () => {
  const result = snapshot({
    lastRewrite: {
      endpoint: '/backend-api/f/conversation', fetchRequestId: 'new.1',
      modelAfter: 'gpt-6-astra', capturedAt: '2026-10-18T13:35:07Z',
    },
    lastRequest: { requestId: 'old.1', model: 'gpt-6-astra', capturedAt: '2026-10-18T13:28:26Z' },
    lastVerification: {
      model: 'gpt-6', evidenceSource: 'network_response_metadata',
      verdict: 'mismatch', verifiedAt: '2026-10-18T13:28:55Z',
      reasons: ['model_not_allowed'],
    },
    lastResponseEvidence: {
      requestId: 'old.1', model: 'gpt-6', fields: { model: 'message.metadata.resolved_model_slug' },
      evidenceSource: 'network_response_metadata', capturedAt: '2026-10-18T13:28:55Z',
    },
    phase: 'mismatch',
  });
  assert.equal(result.request.id, 'gpt-6-astra');
  assert.equal(result.response.id, null);
  assert.match(result.response.label, /等待本轮真实响应/);
  assert.equal(result.response.mismatch, false);
});

test('family-only response is displayed with uncertainty, not actual confirmed variant', () => {
  const result = snapshot({
    lastRequest: { requestId: 'new.1', model: 'gpt-6-astra', capturedAt: '2026-10-18T13:35:07Z' },
    lastResponseEvidence: {
      requestId: 'new.1', model: 'gpt-6',
      fields: { model: 'message.metadata.resolved_model_slug' },
      evidenceSource: 'network_response_metadata', capturedAt: '2026-10-18T13:35:25Z',
    },
    responseModelIdentity: { status: 'family_only' },
    lastVerification: {
      model: null, evidenceSource: 'network_response_metadata',
      verdict: 'incomplete', verifiedAt: '2026-10-18T13:35:26Z',
      reasons: ['model_missing'],
    },
    phase: 'incomplete',
  });
  assert.equal(result.response.id, 'gpt-6');
  assert.match(result.response.label, /仅家族标识，变体未确认/);
  assert.equal(result.response.confirmed, false);
  assert.equal(result.response.mismatch, false);
});

test('normal response verifier passes no variant claim to Native on family-only evidence', () => {
  assert.match(background, /model: inconclusiveVariant \? null : modelObservation\.model/);
  assert.match(background, /response_model_variant_unresolved/);
  assert.match(background, /responseModelIdentity: state\.responseModelIdentity/);
});
