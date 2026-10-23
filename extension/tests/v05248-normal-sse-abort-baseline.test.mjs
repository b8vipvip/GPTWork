import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { normalChatSseBaseline } from '../astra-debug-sse.js';

function assistant(status, extra = {}) {
  return 'data: ' + JSON.stringify({ v: { message: {
    author: { role: 'assistant' }, status, ...extra,
  } } }) + '\n\n';
}
function evidence(body, fields = {}) {
  return {
    requestId: 'normal.17', status: 200, model: 'gpt-6-thinking',
    rawResponseBody: body, diagnostics: {
      stage: 'initial_conversation_aborted',
      transport: 'sse', networkError: 'net::ERR_ABORTED',
      httpStatus: 200, streamCaptureBytes: 9000, ...fields,
    },
  };
}

test('normal aborted ChatGPT request is logged with exactly same SSE categories as debug', () => {
  const body = assistant('in_progress', { content: { parts: ['PRIVATE_PROMPT_OR_RESPONSE'] } })
    + 'data: [DONE]\n\n';
  const baseline = normalChatSseBaseline(evidence(body));
  assert.equal(baseline.requestId, 'normal.17');
  assert.equal(baseline.httpStatus, 200);
  assert.equal(baseline.networkError, 'net::ERR_ABORTED');
  assert.equal(baseline.transportEndedNormally, false);
  assert.equal(baseline.servedModel, 'gpt-6-thinking');
  assert.equal(baseline.sseTerminalKind, 'data_done');
  assert.equal(baseline.sseAssistantMessageSeen, true);
  assert.equal(baseline.sseAssistantFinalSeen, false);
  assert.equal(baseline.sseAssistantStatus, 'in_progress');
  assert.equal(baseline.streamCaptureBytes, 9000);
  assert.equal(JSON.stringify(baseline).includes('PRIVATE_PROMPT_OR_RESPONSE'), false);
  assert.equal('rawResponseBody' in baseline, false);
});

test('normal completed response and application error remain independent', () => {
  const body = assistant('finished_successfully') + 'data: [DONE]\n\n';
  const baseline = normalChatSseBaseline(evidence(body, {
    stage: 'initial_conversation', networkError: null,
  }));
  assert.equal(baseline.transportEndedNormally, true);
  assert.equal(baseline.sseAssistantFinalSeen, true);
  const failedApp = normalChatSseBaseline(evidence('event: error\ndata: {}\n\n'));
  assert.equal(failedApp.transportEndedNormally, false);
  assert.equal(failedApp.sseApplicationErrorSeen, true);
});

test('excluded Astra request, unrelated stages, missing body and untrusted errors never enter baseline', () => {
  const body = assistant('in_progress');
  assert.equal(normalChatSseBaseline(evidence(body), 'normal.17'), null);
  assert.equal(normalChatSseBaseline(evidence(body, {stage:'downstream_websocket'})), null);
  const bodyMissing = normalChatSseBaseline({...evidence(body), rawResponseBody: null});
  assert.ok(bodyMissing, 'an aborted ordinary request must not silently disappear from the baseline');
  assert.equal(bodyMissing.requestId, 'normal.17');
  assert.equal(bodyMissing.networkTerminal, 'loadingFailed');
  assert.equal(bodyMissing.networkError, 'net::ERR_ABORTED');
  assert.equal(bodyMissing.transportEndedNormally, false);
  assert.equal(bodyMissing.sseEvidenceAvailable, false);
  assert.equal(bodyMissing.sseUnavailableReason, 'response_body_not_exposed_to_observer');
  assert.equal(bodyMissing.sseAssistantFinalSeen, null, 'unknown is not false');
  assert.equal(bodyMissing.sseApplicationErrorSeen, null, 'unknown is not a clean server response');
  assert.equal(bodyMissing.sseJsonEvents, null);
  assert.equal(bodyMissing.sseTerminalKind, null);
  const outcome = normalChatSseBaseline(evidence(body, {networkError:'very-private-error: SECRET'}));
  assert.equal(outcome.networkError,'other_network_error');
  assert.equal(JSON.stringify(outcome).includes('SECRET'), false);
});

test('normal baseline has no path to mutate request model or terminate verifier', async () => {
  const [background, source, manifestText] = await Promise.all([
    'background.js','astra-debug-sse.js','manifest.json'
  ].map(x=>readFile(new URL('../'+x,import.meta.url),'utf8')));
  assert.match(background,/normalChatSseBaseline\(evidence, debug\?\.requestId \|\| null\)/);
  assert.match(background,/normal_conversation_sse_baseline_observed/);
  assert.match(source,/transportEndedNormally/);
  assert.doesNotMatch(source,/Fetch\.continueRequest|Fetch\.failRequest|chrome\.debugger\.sendCommand/);
  assert.equal(JSON.parse(manifestText).version,'0.5.249');
});
