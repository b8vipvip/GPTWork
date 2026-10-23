import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { analyzeAstraDebugSse } from '../astra-debug-sse.js';
import { astraDebugVerdict, ASTRA_DEBUG_TRANSPORT } from '../astra-debug-probe.js';

function event(value, name = 'message') {
  return 'event: ' + name + '\ndata: ' + JSON.stringify(value) + '\n\n';
}

test('DONE alone is a stream marker, not an assistant final or Astra identity', () => {
  const result = analyzeAstraDebugSse(event({ type: 'partial_response' }) + 'data: [DONE]\n\n');
  assert.equal(result.sseTerminalKind, 'data_done');
  assert.equal(result.sseAssistantMessageSeen, false);
  assert.equal(result.sseAssistantFinalSeen, false);
  assert.equal(result.sseApplicationErrorSeen, false);
  assert.equal(result.sseJsonEvents, 1);
  assert.equal(astraDebugVerdict({
    forwardedTransportModel: ASTRA_DEBUG_TRANSPORT,
    httpStatus: 200, networkError: 'net::ERR_ABORTED',
    terminalEvent: 'conversation_response_failed',
    responseModel: 'gpt-6', sseTerminalObserved: true,
    sseTerminalKind: result.sseTerminalKind,
  }).modelVerdict, 'unverified');
});

test('SSE app error and DONE can coexist; no raw error text leaves classifier', () => {
  const sensitive = 'PRIVATE_SECRET_987';
  const body = event({ type: 'error', message: sensitive })
    + event({ type: 'message', message: { author: { role: 'assistant' },
      status: 'finished_with_errors', content: { parts: [sensitive] } } })
    + 'data: [DONE]\n\n';
  const report = analyzeAstraDebugSse(body);
  assert.equal(report.sseApplicationErrorSeen, true);
  assert.equal(report.sseAssistantMessageSeen, true);
  assert.equal(report.sseAssistantFinalSeen, false);
  assert.equal(report.sseAssistantStatus, 'finished_with_errors');
  assert.equal(report.sseTerminalKind, 'data_done');
  assert.equal(JSON.stringify(report).includes(sensitive), false);
});

test('complete assistant status is independent of model proof and network terminal', () => {
  const report = analyzeAstraDebugSse(
    event({ message: { author: { role: 'assistant' }, status: 'finished_successfully' } })
      + 'event: message_stream_complete\ndata: {}\n\n'
  );
  assert.equal(report.sseAssistantFinalSeen, true);
  assert.equal(report.sseTerminalKind, 'event_done');
  assert.equal(report.sseApplicationErrorSeen, false);
  const probe = { forwardedTransportModel: ASTRA_DEBUG_TRANSPORT, httpStatus: 200,
    terminalEvent: 'conversation_response_failed', networkError: 'net::ERR_ABORTED',
    responseModel: 'gpt-6', sseAssistantFinalSeen: true };
  assert.equal(astraDebugVerdict(probe).requestOutcome, 'failed');
  assert.equal(astraDebugVerdict(probe).modelVerdict, 'unverified');
});

test('partial, multiline, large and non-JSON SSE fail closed and remain bounded', () => {
  const report = analyzeAstraDebugSse('data: {bad json}\n\ndata: [DONE]\n\n');
  assert.equal(report.sseJsonEvents, 0);
  assert.equal(report.sseTerminalKind, 'data_done');
  const tooLarge = analyzeAstraDebugSse('x'.repeat(4 * 1024 * 1024 + 1));
  assert.equal(tooLarge.sseCaptureTruncated, true);
  assert.equal(tooLarge.sseTerminalKind, null);
  const multiline = analyzeAstraDebugSse('event: message\ndata: {"type":\ndata: "error"}\n\n');
  assert.equal(multiline.sseApplicationErrorSeen, true);
  assert.equal(analyzeAstraDebugSse(null).sseTerminalKind, null);
});

test('probe wiring exports safe SSE evidence, request 404 count and raw response never persists', async () => {
  const [background, probe, page, script, manifest] = await Promise.all(
    ['background.js', 'astra-debug-probe.js', 'debug-tools.html', 'debug-tools.js', 'manifest.json']
      .map(async (path) => readFile(new URL('../' + path, import.meta.url), 'utf8'))
  );
  assert.match(background, /analyzeAstraDebugSse\(evidence\?\.rawResponseBody\)/);
  assert.match(background, /astra_debug_conversation_detail_404_observed/);
  assert.match(background, /sseApplicationErrorSeen/);
  assert.match(probe, /'sseAssistantFinalSeen'/);
  assert.doesNotMatch(probe.split('export function publicAstraDebugProbe(probe) {')[1],
    /'rawResponseBody'/);
  assert.match(page, /id="probeSseAppError"/);
  assert.match(script, /probeConversation404/);
  assert.equal(JSON.parse(manifest).version, '0.5.247');
});
