// [legacy-core-maintenance] v0.5.204: a native Work probe must not claim
// a different or stale request as belonging to the selected model.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeConcreteModelId, modelTransportId } from '../policy.js';
import { verifyOfficialWorkRequestIdentity } from '../vendor/modelpro/model-verification.js';

const judge = (expectedModel, rawRequestModel, responseRequestId = 'cdp-42', requestRequestId = 'cdp-42', rewriteRequestId = null) =>
  verifyOfficialWorkRequestIdentity({
    expectedModel, rawRequestModel, responseRequestId, requestRequestId,
    rewriteRequestId, normalizeModel: normalizeConcreteModelId,
  });

test('Work-native request is confirmed only for the matching model and request ID', () => {
  assert.deepEqual(judge('gpt-5.6-sol', 'gpt-5.6-sol-wm'), { confirmed: true, issue: null });
  assert.equal(judge('gpt-5.6-sol', 'gpt-5.5-wm').issue, 'work_native_request_model_mismatch');
  assert.equal(judge('gpt-5.6-sol', 'gpt-5.6-sol-wm', 'cdp-43').issue, 'work_native_request_id_mismatch');
  assert.equal(judge('gpt-5.6-sol', null).issue, 'work_native_request_model_missing');
  assert.equal(judge('gpt-5.6-sol', 'gpt-5.6-sol-wm', null).issue, 'work_native_response_request_id_missing');
  assert.deepEqual(judge('gpt-6-astra', 'gpt-6-astra-wm', 'cdp-99', null, 'cdp-99'), { confirmed: true, issue: null });
});

test('all observed Work transports map to the correct concrete model, including 6.1 Sol', () => {
  const work = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
  for (const model of work) {
    const raw = model + '-wm';
    assert.equal(normalizeConcreteModelId(raw), model);
    assert.deepEqual(judge(model, raw), { confirmed: true, issue: null });
  }
  assert.equal(modelTransportId('gpt-6.1-sol'), 'gpt-6.1-sol-wm');
});

test('background binds native request evidence before claiming selection, and never fakes response identity', async () => {
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function discoverOfficialWorkModels(');
  const end = source.indexOf('async function publishAccountModels(', start);
  assert.ok(start >= 0 && end > start);
  const scope = source.slice(start, end);
  assert.match(scope, /lastRewrite\?\.requestId === evidenceRequestId/);
  assert.match(scope, /lastRequest\?\.requestId === evidenceRequestId/);
  assert.match(scope, /expectedModel: model,/);
  assert.match(scope, /const nativeRequestConfirmed = workRequestEvidence\.confirmed/);
  assert.match(scope, /const nativeResponseConfirmed = Boolean\(rawResponseModel && nativeResponseCompatible\)/);
  assert.match(scope, /nativeResponseCompatible !== false/);
});
