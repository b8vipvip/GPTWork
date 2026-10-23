import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { analyzeAstraDebugSse, normalChatSseBaseline } from '../astra-debug-sse.js';

function event(status, endTurn = false, role = 'assistant') {
  return 'data: ' + JSON.stringify({
    v: { message: { author: { role }, status, end_turn: endTurn,
      content: { parts: ['PRIVATE_MESSAGE_TEXT'] } } },
  }) + '\n\n';
}

test('intermediate successful assistant message and later in_progress do not prove end-of-turn', () => {
  const data = event('in_progress') + event('finished_successfully', false)
    + event('in_progress') + 'data: [DONE]\n\n';
  const result = analyzeAstraDebugSse(data);
  assert.equal(result.sseAssistantFinalSeen, true, 'one message reached finished_successfully');
  assert.equal(result.sseAssistantEndTurnSeen, false, 'no assistant end_turn=true was observed');
  assert.equal(result.sseAssistantStatus, 'in_progress', 'most recent assistant message state');
  assert.deepEqual(result.sseAssistantStatusSequence, [
    'in_progress', 'finished_successfully', 'in_progress',
  ]);
  assert.equal(result.sseTerminalKind, 'data_done');
  assert.equal(JSON.stringify(result).includes('PRIVATE_MESSAGE_TEXT'), false);
});

test('terminal assistant end_turn is a separate application signal, still not browser network success', () => {
  const body = event('in_progress') + event('finished_successfully', true) + 'data: [DONE]\n\n';
  const result = analyzeAstraDebugSse(body);
  assert.equal(result.sseAssistantEndTurnSeen, true);
  assert.equal(result.sseAssistantFinalSeen, true);
  const baseline = normalChatSseBaseline({
    requestId: 'normal.250', status: 200, model: 'gpt-6-thinking',
    rawResponseBody: body,
    diagnostics: {
      stage: 'initial_conversation_aborted', networkError: 'net::ERR_ABORTED',
      terminalEvent: 'loadingFailed', streamCaptureBytes: 15500,
    },
  });
  assert.equal(baseline.sseAssistantEndTurnSeen, true);
  assert.equal(baseline.transportEndedNormally, false);
  assert.equal(baseline.networkTerminal, 'loadingFailed');
});

test('non-assistant, invalid-status, and message with end_turn without success never confirm turn final', () => {
  const result = analyzeAstraDebugSse(event('finished_successfully', true, 'user')
    + event('in_progress', true) + event('unknown', true));
  assert.equal(result.sseAssistantEndTurnSeen, false);
  assert.equal(result.sseAssistantFinalSeen, false);
  assert.deepEqual(result.sseAssistantStatusSequence, ['in_progress']);
});

test('bounded status transitions record only allowlisted enum strings and do not leak text', () => {
  let body = '';
  for (let i = 0; i < 30; i++) body += event(i % 2 ? 'pending' : 'in_progress');
  const result = analyzeAstraDebugSse(body);
  assert.equal(result.sseAssistantStatusSequence.length, 16);
  assert.equal(JSON.stringify(result).includes('PRIVATE_MESSAGE_TEXT'), false);
  assert.ok(result.sseAssistantStatusSequence.every(x => ['in_progress','pending'].includes(x)));
});

test('missing normal-response body leaves both final signals and status transition timeline unknown', () => {
  const baseline = normalChatSseBaseline({
    requestId: 'normal.251', status: 200, model: 'gpt-6-thinking',
    rawResponseBody: null,
    diagnostics: { stage: 'initial_conversation_aborted', networkError: 'net::ERR_ABORTED' },
  });
  assert.equal(baseline.sseEvidenceAvailable, false);
  assert.equal(baseline.sseAssistantEndTurnSeen, null);
  assert.equal(baseline.sseAssistantStatusSequence, null);
});

test('probe and UI display distinct assistant turn and per-message signals', async () => {
  const read = x => readFile(new URL('../' + x, import.meta.url), 'utf8');
  const [background, probe, ui, html, manifest] = await Promise.all(
    ['background.js','astra-debug-probe.js','debug-tools.js','debug-tools.html','manifest.json'].map(read));
  assert.match(background, /sseAssistantEndTurnSeen: debug\.sseAssistantEndTurnSeen \|\| sse\.sseAssistantEndTurnSeen/);
  assert.match(background, /sseAssistantStatusSequence: sse\.sseAssistantStatusSequence/);
  assert.match(probe, /'sseAssistantEndTurnSeen'/);
  assert.match(probe, /'sseAssistantStatusSequence'/);
  assert.match(ui, /probeSseEndTurn/);
  assert.match(html, /id="probeSseStatusSequence"/);
  assert.equal(JSON.parse(manifest).version, '0.5.250');
});
