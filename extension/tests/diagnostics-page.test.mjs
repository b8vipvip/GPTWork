import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  createDiagnosticsReport,
  DIAGNOSTICS_STORAGE_KEYS,
  enrichVerificationSnapshot,
  latestGatePublication,
  selectLatestVerification,
  summarizeModelResult,
  summarizeStreamCapture,
} from '../diagnostics-evidence.js';

const reportA = {
  id: 'run-a',
  startedAt: '2026-11-15T10:00:00.000Z',
  completedAt: '2026-11-15T10:01:00.000Z',
  outcome: 'partial',
  catalogVerification: {
    total: 2, verified: 1, failed: 1, requestConfirmed: 2,
    results: [{ model: 'gpt-5.5', requestConfirmed: true, responseConfirmed: false,
      requestModel: 'gpt-5.5-thinking', rawRequestModel: 'gpt-5.5-thinking',
      responseIssue: 'served_model_mismatch', requestId: 'req-a' }],
  },
};
const reportB = {
  id: 'run-b', startedAt: '2026-11-15T11:00:00.000Z',
  completedAt: '2026-11-15T11:02:00.000Z', outcome: 'verified',
  total: 1, verified: 1, failed: 0,
  results: [{ model: 'gpt-6', requestConfirmed: true, responseConfirmed: true,
    responseModel: 'gpt-6', requestId: 'req-b' }],
};

test('latest verification is selected by evidence timestamp across live tabs, history and logs', () => {
  const selected = selectLatestVerification({
    tabs: [{ autoVerification: reportA }],
    history: [reportB],
    runtimeLogs: [{ component: 'discovery', event: 'auto_verify_completed',
      timestamp: '2026-11-15T12:00:00.000Z',
      details: { outcome: 'partial', catalogTotal: 3, catalogVerified: 1,
        catalogFailed: 2, models: [{ model: 'gpt-5.6-sol', requestConfirmed: true }] } }],
  });
  assert.equal(selected.source, 'runtime-log');
  assert.equal(selected.total, 3);
  assert.equal(selected.results[0].model, 'gpt-5.6-sol');
});

test('autoVerify attempt summaries are used when the background leaves catalogVerification null', () => {
  const snapshot = selectLatestVerification({
    tabs: [{
      autoVerification: {
        startedAt: '2026-11-15T10:00:00.000Z',
        completedAt: '2026-11-15T10:01:00.000Z',
        executionTabId: 29,
        maxAttempts: 2,
        outcome: 'partial',
        catalogVerification: null,
        attempts: [
          { attempt: 1, requestLockConfirmed: true, requestModel: 'gpt-6-astra',
            responseModel: 'gpt-6', responseConfirmed: false, outcome: 'unverified' },
          { attempt: 2, requestLockConfirmed: true, requestModel: 'gpt-5.6-sol',
            responseModel: 'gpt-5.6-sol', responseConfirmed: true, outcome: 'verified' },
        ],
      },
    }],
  });
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.requestConfirmed, 2);
  assert.equal(snapshot.verified, 1);
  assert.equal(snapshot.results.length, 2);
  assert.equal(snapshot.results[0].requestModel, 'gpt-6-astra');
});

test('runtime events enrich only their matching probe and execution tab', () => {
  const snapshot = selectLatestVerification({
    tabs: [{
      autoVerification: {
        startedAt: '2026-11-15T10:00:00.000Z',
        completedAt: '2026-11-15T10:01:00.000Z',
        executionTabId: 29,
        maxAttempts: 1,
        outcome: 'partial',
        attempts: [{ attempt: 1, requestId: 'req-exact-1', requestLockConfirmed: true,
          requestModel: 'gpt-6-astra', responseModel: 'gpt-6',
          responseConfirmed: false, outcome: 'unverified' }],
      },
    }],
  });
  const logs = [
    { timestamp: '2026-11-15T10:00:20.000Z', component: 'network',
      event: 'formal_conversation_request_detected',
      details: { tabId: 29, requestId: 'req-exact-1', model: 'gpt-6-astra',
        observedModel: 'gpt-6-astra' } },
    { timestamp: '2026-11-15T10:00:29.000Z', component: 'network',
      event: 'conversation_response_metadata_observed',
      details: { tabId: 29, requestId: 'req-exact-1', transportRequestId: 'downstream-1',
        rawResponseModel: 'gpt-6', httpStatus: 200 } },
    { timestamp: '2026-11-15T10:00:30.000Z', component: 'discovery',
      event: 'response_evaluated',
      details: { tabId: 29, requestId: 'req-exact-1', requestModel: 'gpt-6-astra',
        originalResponseModel: 'gpt-6', rawResponseModel: 'gpt-6',
        responseModelField: 'message.metadata.resolved_model_slug',
        diagnostics: { httpStatus: 200 },
        modelIdentity: { status: 'family_only', requestedModel: 'gpt-6-astra',
          observedModel: 'gpt-6', responseField: 'message.metadata.resolved_model_slug',
          variantConfirmed: false, definitiveMismatch: false } } },
  ];
  logs.push(
    { timestamp: '2026-11-15T10:00:40.000Z', component: 'network',
      event: 'formal_conversation_request_detected',
      details: { tabId: 29, requestId: 'baseline', model: 'gpt-6-astra', observedModel: 'wrong-request' } },
    { timestamp: '2026-11-15T10:00:41.000Z', component: 'discovery',
      event: 'response_evaluated',
      details: { tabId: 29, requestModel: 'gpt-6-astra', rawResponseModel: 'missing-request-id' } },
    { timestamp: '2026-11-15T10:00:42.000Z', component: 'network',
      event: 'conversation_response_metadata_observed',
      details: { tabId: 30, requestId: 'req-exact-1', rawResponseModel: 'wrong-tab' } },
  );
  const enriched = enrichVerificationSnapshot(snapshot, logs);
  assert.equal(enriched.results[0].requestId, 'req-exact-1');
  assert.equal(enriched.results[0].responseRequestId, 'req-exact-1');
  assert.equal(enriched.results[0].rawRequestModel, '');
  assert.equal(enriched.results[0].networkObservedRequestModel, 'gpt-6-astra');
  assert.equal(enriched.results[0].transportResponseRequestId, 'downstream-1');
  assert.equal(enriched.results[0].rawResponseModel, 'gpt-6');
  assert.equal(enriched.results[0].responseModelField, 'message.metadata.resolved_model_slug');
  assert.equal(enriched.results[0].responseHttpStatus, 200);
  assert.equal(enriched.results[0].responseModelIdentity.status, 'family_only');
  assert.equal(enriched.results[0].responseConfirmed, false);
});

test('four-gate publication summary comes only from the explicit shared catalog publication event', () => {
  const summary = latestGatePublication([{
    timestamp: '2026-11-15T10:05:00.000Z',
    component: 'discovery',
    event: 'shared_model_catalog_published',
    details: { submitted: 4, nativeResponseConfirmed: 2,
      workNativeResponseObserved: 3, workNativeResponseMetadataConfirmed: 1,
      chatLockSupported: 2, fourGateEligible: 1, shared: 1, generation: 42 },
  }]);
  assert.equal(summary.fourGateEligible, 1);
  assert.equal(summary.chatLockSupported, 2);
  assert.equal(summary.workNativeResponseObserved, 3);
  assert.equal(latestGatePublication([]), null);
});

test('request and response identities remain separate and missing raw fields stay missing', () => {
  const row = summarizeModelResult({
    model: 'gpt-5.5', requestConfirmed: true, requestModel: 'gpt-5.5-thinking',
    responseConfirmed: false, responseModel: null, requestId: 'req-1',
  });
  assert.equal(row.requestConfirmed, true);
  assert.equal(row.responseConfirmed, false);
  assert.equal(row.rawRequestModel, '');
  assert.equal(row.rawResponseModel, '');
  assert.equal(row.responseModel, '');
  assert.equal(row.responseRequestId, '');
});

test('stream summary contains correlation metadata but never raw SSE or WebSocket content', () => {
  const rawSse = 'data: {"resume_conversation_token":"SECRET","message":"PRIVATE"}';
  const rawFrame = '{"conversation_id":"PRIVATE"}';
  const summary = summarizeStreamCapture({
    schemaVersion: 2, captureScope: 'auto_verification_stream_only',
    totalBytes: 99, includedBytes: 99, maxBytes: 100, overflowed: false,
    entries: [{ requestId: 'req-1', transport: 'sse', direction: 'received',
      stage: 'initial', bodyBytes: 99, rawSse }, { requestId: 'req-2',
      transport: 'websocket', bodyBytes: 0, rawFrame }],
  });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('SECRET'), false);
  assert.equal(serialized.includes('PRIVATE'), false);
  assert.equal(serialized.includes('rawSse'), false);
  assert.equal(serialized.includes('rawFrame'), false);
  assert.equal(summary.entries.length, 2);
});

test('diagnostic export omits raw stream payload and reports privacy boundary', () => {
  const report = createDiagnosticsReport({
    bundle: { extension: { version: '0.5.253' }, tabs: [{ autoVerification: reportA }] },
    runtimeLogs: [], history: [reportA], historyEnabled: true,
    streamCapture: { entries: [{ requestId: 'req-1', rawSse: 'SECRET' }] },
    generatedAt: '2026-11-15T12:00:00.000Z',
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('SECRET'), false);
  assert.equal(report.privacy.rawSseIncluded, false);
  assert.equal(report.modelVerification.latest.results[0].rawRequestModel, 'gpt-5.5-thinking');
});

test('disabled model history is not surfaced in the exported latest snapshot', () => {
  const report = createDiagnosticsReport({
    bundle: {},
    runtimeLogs: [],
    history: [reportB],
    historyEnabled: false,
    generatedAt: '2026-11-15T12:00:00.000Z',
  });
  assert.equal(report.modelVerification.historyCount, null);
  assert.equal(report.modelVerification.history.length, 0);
  assert.equal(report.modelVerification.latest, null);
});

test('storage keys match the existing background runtime exports', async () => {
  assert.deepEqual(DIAGNOSTICS_STORAGE_KEYS, {
    history: 'modelVerificationHistoryV1',
    historyEnabled: 'gptworkModelVerificationHistoryEnabled',
    streamCapture: 'autoVerificationSseCapture',
  });
  const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(background, /GPTLOCK_EXPORT_DIAGNOSTICS/);
  assert.match(background, /GPTLOCK_GET_RUNTIME_LOGS/);
  assert.match(background, /autoVerificationSseCapture/);
  assert.match(background, /modelVerificationHistoryV1/);
});

test('the diagnostics route resolves to a real standalone page and does not edit frozen runtime', async () => {
  const [html, script, background] = await Promise.all([
    readFile(new URL('../diagnostics.html', import.meta.url), 'utf8'),
    readFile(new URL('../diagnostics.js', import.meta.url), 'utf8'),
    readFile(new URL('../background.js', import.meta.url), 'utf8'),
  ]);
  assert.match(background, /chrome\.runtime\.getURL\('diagnostics\.html'\)/);
  assert.match(html, /src="diagnostics\.js"/);
  assert.match(script, /GPTLOCK_EXPORT_DIAGNOSTICS/);
  assert.match(script, /GPTLOCK_GET_RUNTIME_LOGS/);
  assert.doesNotMatch(script, /rawSse|rawFrame|responseBody/);
});

test('exports both stages from the full catalog completion log for the matching execution tab', () => {
  const runtimeLogs = [
    {
      component: 'discovery', event: 'model_discovery_started', timestamp: '2026-11-15T10:00:00Z',
      details: { tabId: 29 },
    },
    {
      component: 'network', event: 'conversation_response_metadata_observed', timestamp: '2026-11-15T09:59:59Z',
      details: { tabId: 29, requestId: 'chat-1', rawResponseModel: 'stale-response' },
    },
    {
      component: 'discovery', event: 'model_discovery_completed', timestamp: '2026-11-15T10:00:30Z',
      details: { tabId: 29, total: 2, requestConfirmed: 2, verified: 1, failed: 1, results: [
        { model: 'gpt-6', pickerMode: 'A', selectorKey: 'native', requestId: 'native-1',
          selected: true, verified: true, requestConfirmed: true, responseConfirmed: true, rawResponseModel: 'gpt-6' },
        { model: 'gpt-6', pickerMode: 'A', selectorKey: '__picker_a_chat_lock__', requestId: 'chat-1',
          requestConfirmed: true, responseConfirmed: false, nativeResponseModel: 'gpt-6', responseHttpStatus: 0 },
      ] },
    },
    {
      component: 'discovery', event: 'model_discovery_completed', timestamp: '2026-11-15T10:00:31Z',
      details: { tabId: 30, results: [{ model: 'unrelated' }] },
    },
    {
      component: 'discovery', event: 'auto_verify_completed', timestamp: '2026-11-15T10:00:32Z',
      details: { tabId: 17, executionTabId: 29, outcome: 'partial', models: [{ model: 'gpt-6' }] },
    },
  ];
  const report = createDiagnosticsReport({ runtimeLogs });
  const { latest } = report.modelVerification;
  assert.equal(latest.resultSource, 'catalog');
  assert.equal(latest.verified, 1);
  assert.equal(latest.failed, 1);
  assert.deepEqual(latest.results.map((item) => item.requestId), ['native-1', 'chat-1']);
  assert.equal(latest.results[0].selectionAttempted, true);
  assert.equal(latest.results[1].selectorKey, '__picker_a_chat_lock__');
  assert.equal(latest.results[1].rawResponseModel, '');
  assert.equal(latest.results[1].responseHttpStatus, null);
  assert.equal(latest.results[1].responseConfirmed, false);
});

test('legacy summaries without request IDs leave correlation fields unknown', () => {
  const snapshot = { startedAt: '2026-11-15T10:00:00Z', executionTabId: 29, results: [{ model: 'gpt-6' }] };
  const logs = [
    { timestamp: '2026-11-15T10:00:20Z', event: 'formal_conversation_request_detected',
      details: { tabId: 29, requestId: 'unrelated-request', model: 'gpt-6' } },
    { timestamp: '2026-11-15T10:00:21Z', event: 'response_evaluated',
      details: { tabId: 29, requestId: 'unrelated-request', requestModel: 'gpt-6', rawResponseModel: 'gpt-6' } },
  ];
  const { results: [row] } = enrichVerificationSnapshot(snapshot, logs);
  assert.equal(row.requestId, '');
  assert.equal(row.rawResponseModel, '');
  assert.equal(row.responseConfirmed, null);
  assert.equal(row.responseModelIdentity, null);
});

test('older publication events preserve missing counts and explicit zero', () => {
  const gate = latestGatePublication([{
    component: 'discovery', event: 'shared_model_catalog_published',
    timestamp: '2026-11-15T10:00:32Z', details: { submitted: 2, fourGateEligible: 0 },
  }]);
  assert.equal(gate.fourGateEligible, 0);
  assert.equal(gate.chatLockSupported, null);
});
