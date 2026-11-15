import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createModelEvidenceDiagnosticReport } from '../model-evidence-diagnostic-report.js';

const rawStream = '{"used_model_slug":"gpt-6-astra"}';

test('diagnostic report correlates captured response evidence only by exact request ID', () => {
  const bundle = {
    generatedAt: '2026-11-15T12:00:00Z',
    extension: { version: '0.5.253' },
    tabs: [{
      tabId: 17,
      autoVerification: {
        verificationSurface: 'chat',
        outcome: 'partial',
        catalogVerification: {
          total: 1,
          verified: 0,
          failed: 1,
          results: [{
            model: 'gpt-5.5',
            pickerMode: 'A',
            requestId: 'request-17',
            requestModel: 'gpt-5.5',
            rawRequestModel: 'gpt-5.5',
            responseConfirmed: false,
            responseIssue: 'picker_a_chat_lock_response_mismatch',
          }],
        },
      },
    }],
    autoVerificationStream: {
      includedBytes: rawStream.length,
      entries: [
        { requestId: 'request-17', transport: 'sse', stage: 'response', mimeType: 'application/json', rawSse: rawStream },
        { requestId: 'request-other', transport: 'sse', stage: 'response', mimeType: 'application/json', rawSse: '{"used_model_slug":"gpt-6"}' },
      ],
    },
    runtimeLogs: [],
  };

  const report = createModelEvidenceDiagnosticReport(bundle);
  const result = report.verificationRuns[0].models[0];

  assert.equal(result.requestId, 'request-17');
  assert.equal(result.pickerMode, 'A');
  assert.equal(result.responseIssue, 'picker_a_chat_lock_response_mismatch');
  assert.equal(result.responseConfirmed, false);
  assert.equal(result.streamEvidence.length, 1);
  assert.equal(result.streamEvidence[0].requestId, 'request-17');
  assert.equal(result.streamEvidence[0].parsedResponseCandidate.rawModel, 'gpt-6-astra');
  assert.equal(result.streamEvidence[0].verificationAuthority, false);
});

test('diagnostic summary excludes raw stream payloads and states that parsed candidates are non-authoritative', () => {
  const bundle = {
    autoVerificationStream: {
      entries: [{ requestId: 'r1', transport: 'sse', mimeType: 'application/json', rawSse: rawStream }],
    },
  };
  const report = createModelEvidenceDiagnosticReport(bundle);
  const serialized = JSON.stringify(report);

  assert.equal(serialized.includes(rawStream), false);
  assert.equal(report.privacy.summaryIncludesRawStreamPayloads, false);
  assert.equal(report.privacy.fullBundleIncludesRawStreamPayloads, true);
  assert.equal(report.evidencePolicy.parsedStreamAuthority, false);
});

test('diagnostic report includes persisted model history only when supplied and records the setting state', () => {
  const history = [{ id: 'history-1', outcome: 'partial' }];
  const report = createModelEvidenceDiagnosticReport({}, {
    modelVerificationHistory: history,
    historyEnabled: true,
  });
  assert.equal(report.modelVerificationHistory.enabled, true);
  assert.equal(report.modelVerificationHistory.recordCount, 1);
  assert.equal(report.modelVerificationHistory.records[0].id, 'history-1');
});

test('diagnostics page exists and matches the background open-page route', async () => {
  const [page, background] = await Promise.all([
    readFile(new URL('../diagnostics.html', import.meta.url), 'utf8'),
    readFile(new URL('../background.js', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /src="diagnostics\.js"/);
  assert.match(page, /id="exportSummary"/);
  assert.match(page, /id="exportFull"/);
  assert.match(background, /chrome\.runtime\.getURL\('diagnostics\.html'\)/);
});

test('empty diagnostic bundles render as a valid empty report', () => {
  const report = createModelEvidenceDiagnosticReport({});
  assert.equal(report.type, 'gptwork-model-evidence-diagnostic-report');
  assert.deepEqual(report.verificationRuns, []);
  assert.deepEqual(report.streamCapture.entries, []);
  assert.equal(report.modelVerificationHistory.recordCount, 0);
});
