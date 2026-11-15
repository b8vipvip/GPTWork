import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  createDiagnosticsReport,
  DIAGNOSTICS_STORAGE_KEYS,
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

