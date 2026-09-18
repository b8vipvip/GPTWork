import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendDiagnosticSseCapture,
  boundRuntimeLogs,
  createDiagnosticSseCapture,
  prepareRuntimeLogUploadEntry,
  sanitizeLogValue,
  shouldPersistRuntimeLog,
} from '../runtime-log.js';

test('redacts secrets and chat payload fields while preserving safe technical diagnostics', () => {
  const result = sanitizeLogValue({
    model: 'gpt-5.6-sol',
    authorization: 'Bearer secret',
    requestBody: '{"prompt":"private"}',
    postData: '{"prompt":"private"}',
    postDataLength: 1234,
    chatContent: 'private answer',
    diagnostics: {
      endpoint: '/backend-api/f/conversation',
      modelCandidatePaths: ['message.metadata.model_slug', 'metadata.served_model'],
      nested: { fields: { model: 'message.metadata.model_slug' } },
    },
    nested: { cookie: 'session', status: 200 },
  });
  assert.equal(result.model, 'gpt-5.6-sol');
  assert.equal(result.authorization, '[redacted]');
  assert.equal(result.requestBody, '[redacted]');
  assert.equal(result.postData, '[redacted]');
  assert.equal(result.postDataLength, 1234);
  assert.equal(result.chatContent, '[redacted]');
  assert.equal(result.nested.cookie, '[redacted]');
  assert.equal(result.nested.status, 200);
  assert.deepEqual(result.diagnostics.modelCandidatePaths, [
    'message.metadata.model_slug',
    'metadata.served_model',
  ]);
  assert.equal(result.diagnostics.nested.fields.model, 'message.metadata.model_slug');
});

test('drops high-frequency non-diagnostic bookkeeping while preserving chain evidence', () => {
  assert.equal(shouldPersistRuntimeLog('info', 'lock', 'request_lock_checked', {
    changed: false,
    error: null,
    requestId: null,
    reason: 'private_request_not_official',
  }), false);
  assert.equal(shouldPersistRuntimeLog('info', 'context-budget', 'remaining_snapshot', {
    remainingPercent: 98.7,
    hardLimitObservedCount: 0,
  }), false);
  assert.equal(shouldPersistRuntimeLog('error', 'content-runtime', 'uncaught_error', {
    message: 'ResizeObserver loop completed with undelivered notifications.',
  }), false);
  assert.equal(shouldPersistRuntimeLog('info', 'network', 'formal_conversation_request_detected', {
    requestId: 'cdp-1',
    model: 'gpt-6-astra',
  }), true);
  assert.equal(shouldPersistRuntimeLog('warn', 'verification', 'response_evaluated', {
    requestId: 'cdp-1',
    model: 'gpt-5.6-sol',
  }), true);
});

test('diagnostic array sanitization can retain a selected recent 300-entry export', () => {
  const entries = Array.from({ length: 300 }, (_, index) => ({ index }));
  const result = sanitizeLogValue(entries);
  assert.equal(result.length, 300);
  assert.equal(result[0].index, 0);
  assert.equal(result.at(-1).index, 299);
});

test('bounds the persisted runtime log ring buffer', () => {
  const entries = Array.from({ length: 8 }, (_, index) => ({ index }));
  assert.deepEqual(boundRuntimeLogs(entries, 3), [{ index: 5 }, { index: 6 }, { index: 7 }]);
  assert.deepEqual(boundRuntimeLogs(null), []);
});

test('diagnostic array sanitization keeps the newest entries beyond the 300-entry export ceiling', () => {
  const entries = Array.from({ length: 360 }, (_, index) => ({ index }));
  const result = sanitizeLogValue(entries);
  assert.equal(result[0], '[truncated:360;omitted:60;kept:last]');
  assert.equal(result[1].index, 60);
  assert.equal(result.at(-1).index, 359);
});

test('clips overly long strings without dropping diagnostic context', () => {
  const value = sanitizeLogValue({ error: 'x'.repeat(2500) });
  assert.match(value.error, /^x+…\[truncated:2500\]$/);
  assert.ok(value.error.length < 2100);
});

test('runtime log upload entries stay bounded and preserve the client log id', () => {
  const entry = prepareRuntimeLogUploadEntry({
    id: 'log:test-12345678',
    timestamp: '2026-08-30T08:00:00.000Z',
    level: 'error',
    component: 'network',
    event: 'response_failed',
    details: { authorization: 'Bearer secret', payload: 'x'.repeat(30000) },
  });
  assert.equal(entry.id, 'log:test-12345678');
  assert.equal(entry.details.authorization, '[redacted]');
  assert.ok(JSON.stringify(entry.details).length < 14000);
});

test('keeps auto-verification SSE byte-for-byte when the aggregate stays under the cap', () => {
  const body = 'event: message\ndata: {"type":"debug","model_slug":"gpt-5.6-sol"}\n\n';
  const capture = appendDiagnosticSseCapture(
    createDiagnosticSseCapture({ tabId: 7, startedAt: '2026-08-26T00:00:00.000Z' }),
    {
      attempt: 1,
      requestId: 'req-1',
      endpoint: '/backend-api/f/conversation',
      mimeType: 'text/event-stream',
      bodyFormat: 'sse',
      transport: 'sse',
      rawData: body,
    },
    1024,
  );
  assert.equal(capture.entries.length, 1);
  assert.equal(capture.entries[0].rawSse, body);
  assert.equal(capture.entries[0].transport, 'sse');
  assert.equal(capture.entries[0].bodyBytes, Buffer.byteLength(body));
  assert.equal(capture.includedBytes, Buffer.byteLength(body));
  assert.equal(capture.overflowed, false);
});

test('does not persist a partial raw SSE body when the aggregate size limit would be exceeded', () => {
  let capture = createDiagnosticSseCapture({ tabId: 7 });
  capture = appendDiagnosticSseCapture(capture, { attempt: 1, requestId: 'a', transport: 'sse', rawData: '123456' }, 10);
  capture = appendDiagnosticSseCapture(capture, { attempt: 2, requestId: 'b', transport: 'websocket', rawData: 'abcdef' }, 10);
  assert.equal(capture.entries.length, 1);
  assert.equal(capture.entries[0].rawSse, '123456');
  assert.equal(capture.overflowed, true);
  assert.equal(capture.omittedResponses, 1);
  assert.equal(capture.omittedBytes, 6);
  assert.equal(capture.omitted[0].requestId, 'b');
  assert.equal(capture.omitted[0].reason, 'diagnostic_stream_size_limit');
  assert.equal(capture.captureScope, 'auto_verification_stream_only');
});

test('stores matched WebSocket frames under the same aggregate stream budget', () => {
  const capture = appendDiagnosticSseCapture(
    createDiagnosticSseCapture({ tabId: 9 }),
    {
      attempt: 1,
      requestId: 'ws-1',
      transport: 'websocket',
      direction: 'received',
      stage: 'downstream_websocket',
      rawData: '{"type":"message","metadata":{"model_slug":"gpt-5.6-sol"}}',
    },
    1024,
  );
  assert.equal(capture.entries.length, 1);
  assert.equal(capture.entries[0].transport, 'websocket');
  assert.match(capture.entries[0].rawFrame, /model_slug/);
  assert.equal(capture.entries[0].rawSse, undefined);
});
