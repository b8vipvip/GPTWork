// [legacy-core-maintenance] v0.5.206: terminal empty HTTP/2 responses
// can be retried ONCE after UI settlement; partial SSEs must never replay.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  terminalOfficialWorkTransportFailure,
  shouldRetryOfficialWorkNativeTransport,
} from '../vendor/modelpro/model-verification.js';

const failure = {
  bodyError: 'net::ERR_HTTP2_PROTOCOL_ERROR',
  diagnostics: {httpStatus: 200, parsedObjectCount: 0, streamCaptureBytes: 0},
};
const canRetry = (evidence = failure, changes = {}) =>
  shouldRetryOfficialWorkNativeTransport({
    evidence, nativeRequestConfirmed: true, turnSettled: true,
    requestId: '2072.587', retryCount: 0, ...changes,
  });

test('empty, terminal HTTP2 protocol failure is recognizable independently of HTTP 200 header', () => {
  assert.equal(terminalOfficialWorkTransportFailure(failure), true);
  assert.equal(canRetry(), true);
  assert.equal(canRetry({...failure, bodyError: 'net::ERR_CONNECTION_RESET'}), true);
});

test('no retry for normal/partial SSE, regular abort, contradictory models or other errors', () => {
  assert.equal(canRetry({...failure, bodyError: 'net::ERR_ABORTED'}), false);
  assert.equal(canRetry({...failure, bodyError: null}), false);
  assert.equal(canRetry({...failure, rawModel:'gpt-6'}), false);
  assert.equal(canRetry({...failure, diagnostics:{...failure.diagnostics, parsedObjectCount: 15}}), false);
  assert.equal(canRetry({...failure, diagnostics:{...failure.diagnostics, streamCaptureBytes: 100}}), false);
  assert.equal(canRetry({...failure, diagnostics:{...failure.diagnostics, httpStatus: 503}}), false);
  assert.equal(canRetry({...failure, conflicts:{model:true}}), false);
  assert.equal(canRetry({...failure, rawResponseBody:'data: hello'}), false);
});

test('retry is impossible without original request, confirmed native target, settled UI turn, and budget', () => {
  assert.equal(canRetry(failure,{requestId:null}), false);
  assert.equal(canRetry(failure,{nativeRequestConfirmed:false}), false);
  assert.equal(canRetry(failure,{turnSettled:false}), false);
  assert.equal(canRetry(failure,{retryCount:1}), false);
  assert.equal(canRetry(failure,{retryCount:2}), false);
  assert.equal(canRetry(failure,{maxRetries:0}), false);
});

test('Work-only evidence wait and replay are bounded; model and response gates remain unchanged', async () => {
  const source = await readFile(new URL('../background.js',import.meta.url),'utf8');
  const wait = source.slice(source.indexOf('async function waitForNetworkModelEvidence('),source.indexOf('async function discoverOfficialWorkModels('));
  const work = source.slice(source.indexOf('async function discoverOfficialWorkModels('),source.indexOf('async function publishAccountModels('));
  assert.match(wait,/allowTerminalFailure = false/);
  assert.match(wait,/matchingResponse && allowTerminalFailure && terminalOfficialWorkTransportFailure\(evidence\)/);
  assert.match(work,/allowModelMissing: true, allowTerminalFailure: true/);
  assert.match(work,/shouldRetryOfficialWorkNativeTransport\(/);
  assert.match(work,/nativeTransientRetryCounts\.set\(model, retryCount \+ 1\)/);
  assert.match(work,/index -= 1;/);
  assert.match(work,/nativeRequestConfirmed/);
  assert.match(work,/nativeResponseCompatible !== false/);
  assert.match(work,/settled\?\.settled === true/);
  assert.match(work,/nativeResponseConfirmed = Boolean\(rawResponseModel && nativeResponseCompatible\)/);
});
