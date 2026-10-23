import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { isActiveNewChatRequestHandoff } from '../chat-context-handoff.js';
import { astraDebugVerdict, ASTRA_DEBUG_TRANSPORT } from '../astra-debug-probe.js';

const now = Date.parse('2026-10-23T01:19:01.612Z');
const request = { requestId: '15564.488', capturedAt: '2026-10-23T01:18:57.425Z' };

test('new-chat placeholder and final conversation both preserve one in-flight request', () => {
  assert.equal(isActiveNewChatRequestHandoff('page:/', 'conversation:local-chatgpt', request, now), true);
  assert.equal(isActiveNewChatRequestHandoff('conversation:local-chatgpt',
    'conversation:6adab601-6574-83e8-90d6-f93bf8d0b1fa', request, now), true);
  assert.equal(isActiveNewChatRequestHandoff('conversation:real-one',
    'conversation:real-two', request, now), false, 'other conversation must reset');
  assert.equal(isActiveNewChatRequestHandoff('conversation:local-chatgpt',
    'conversation:real-two', { ...request, requestId: null }, now), false);
  assert.equal(isActiveNewChatRequestHandoff('conversation:local-chatgpt',
    'conversation:real-two', { ...request, capturedAt: '2026-10-22T01:18:57Z' }, now), false);
  assert.equal(isActiveNewChatRequestHandoff('conversation:local-chatgpt',
    'page:/', request, now), false);
});

test('aborted SSE family-only model stays unverified despite 200 and Astra default metadata', () => {
  const probe = {
    forwardedTransportModel: ASTRA_DEBUG_TRANSPORT,
    httpStatus: 200,
    terminalEvent: 'conversation_response_failed',
    networkError: 'net::ERR_ABORTED',
    responseModel: 'gpt-6',
    responseDefaultModel: 'gpt-6-astra',
    responseModelField: 'v.message.metadata.resolved_model_slug',
  };
  assert.deepEqual(astraDebugVerdict(probe), {
    requestAccepted: true, httpSuccess: true, responseCompleted: false,
    requestOutcome: 'failed', modelVerdict: 'unverified',
  });
  assert.equal(astraDebugVerdict({ ...probe, responseModel: 'gpt-6-astra' }).modelVerdict,
    'unverified', 'an aborted exact-model field is not terminal proof');
  assert.equal(astraDebugVerdict({ ...probe, networkError: null,
    terminalEvent: 'conversation_response_finished', responseModel: 'gpt-6' }).modelVerdict,
  'unverified', 'base GPT-6 family is not a variant mismatch');
  assert.equal(astraDebugVerdict({ ...probe, networkError: null,
    terminalEvent: 'conversation_response_finished', responseModel: 'gpt-6-astra' }).modelVerdict,
  'astra_confirmed');
  assert.equal(astraDebugVerdict({ ...probe, networkError: null,
    terminalEvent: 'conversation_response_finished', responseModel: 'gpt-6-sol' }).modelVerdict,
  'different_model');
});

test('aborted network lifecycle retains the debug probe until response evidence callback', async () => {
  const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const protocol = background.split('  onProtocolEvent(tabId, protocol) {')[1]
    ?.split('  onOriginTrace(tabId, trace) {')[0];
  const evidence = background.split('  onEvidence(tabId, evidence) {')[1]
    ?.split('  onStreamData(tabId, streamData) {')[0];
  assert.ok(protocol && evidence);
  assert.doesNotMatch(protocol, /void endDebugAstra\(tabId\)/,
    'protocol failure cannot remove probe before asynchronous SSE decoding');
  assert.match(evidence, /astra_debug_response_model_evidence/);
  assert.match(evidence, /debug\.terminalEvent === 'conversation_response_failed'/);
  assert.match(evidence, /void endDebugAstra\(tabId\)/);
  assert.match(background, /probe\.phase === 'failed'/,
    'fallback alarm must preserve failed outcome rather than overwrite timeout');
});

test('reply observer accepts the first-turn SPA route but still rejects unrelated navigation', async () => {
  const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const observer = content.split('async function waitForDebugAstraReply(options = {}) {')[1]
    ?.split('  async function autoSendProbe(options = {}) {')[0];
  assert.ok(observer);
  assert.match(observer, /startedInNewChat/);
  assert.match(observer, /firstConcreteConversation/);
  assert.match(observer, /expectedNewChatHandoff/);
  assert.match(observer, /conversation_navigated/);
});
