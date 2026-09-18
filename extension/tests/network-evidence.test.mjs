import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractHeaderEvidence,
  extractRequestEvidence,
  extractResponseEvidence,
  extractStreamHandoff,
  isChatGptConversationRequest,
  publicStreamHandoff,
  parseSseObjects,
  rewriteConversationPostData,
  streamPayloadMatches,
} from '../network-evidence.js';

test('extracts strong metadata from a JSON response', () => {
  const result = extractResponseEvidence({
    body: JSON.stringify({ message: { metadata: { model_slug: 'gpt-5.6-sol', reasoning_effort: 'high' } } }),
    mimeType: 'application/json',
  });
  assert.equal(result.model, 'gpt-5.6-sol');
  assert.equal(result.reasoning, 'high');
  assert.equal(result.evidenceSource, 'network_response_metadata');
  assert.equal(result.diagnostics.bodyFormat, 'json');
  assert.equal(result.diagnostics.parsedObjectCount, 1);
  assert.equal(result.diagnostics.modelCandidateCount, 1);
});

test('extracts metadata from SSE without treating DONE as JSON', () => {
  const body = [
    'event: message',
    'data: {"message":{"metadata":{"model_slug":"gpt-5.6-sol","thinking_level":"xhigh"}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  assert.equal(parseSseObjects(body).length, 1);
  const result = extractResponseEvidence({ body, mimeType: 'text/event-stream' });
  assert.deepEqual([result.model, result.reasoning], ['gpt-5.6-sol', 'extra-high']);
});

test('never parses model-looking JSON inside message content', () => {
  const result = extractResponseEvidence({
    body: JSON.stringify({
      message: {
        content: { parts: ['{"model_slug":"gpt-5.5","reasoning_effort":"low"}'] },
        metadata: {},
      },
    }),
  });
  assert.equal(result.model, null);
  assert.equal(result.reasoning, null);
});

test('ignores generic model fields buried in unrelated tool data', () => {
  const result = extractResponseEvidence({
    body: JSON.stringify({ event: { tool: { result: { payload: { model: 'gpt-5.6-sol', reasoning_effort: 'high' } } } } }),
  });
  assert.equal(result.model, null);
  assert.equal(result.reasoning, null);
});

test('marks conflicting highest-confidence metadata as unusable', () => {
  const result = extractResponseEvidence({
    body: JSON.stringify([
      { metadata: { model_slug: 'gpt-5.6-sol' } },
      { metadata: { model_slug: 'gpt-5.5' } },
    ]),
  });
  assert.equal(result.model, null);
  assert.equal(result.conflicts.model, true);
});

test('response headers are whitelisted and normalized', () => {
  const result = extractHeaderEvidence({
    'X-OpenAI-Model': 'GPT-5.6-SOL',
    'X-Reasoning-Effort': 'extra_high',
    Authorization: 'must-not-be-copied',
  });
  assert.deepEqual([result.model, result.reasoning], ['gpt-5.6-sol', 'extra-high']);
  assert.deepEqual(result.fields, {
    model: 'x-openai-model',
    reasoning: 'x-reasoning-effort',
  });
});

test('request metadata stays explicitly non-authoritative', () => {
  const result = extractRequestEvidence('{"model":"gpt-5.6-sol","reasoning_effort":"medium"}');
  assert.equal(result.model, 'gpt-5.6-sol');
  assert.equal(result.reasoning, 'medium');
  assert.equal(result.evidenceSource, 'network_request_metadata');
});

test('only accepts the two formal ChatGPT conversation POST endpoints', () => {
  assert.equal(isChatGptConversationRequest('https://chatgpt.com/backend-api/conversation', 'POST'), true);
  assert.equal(isChatGptConversationRequest('https://chatgpt.com/backend-api/f/conversation', 'POST'), true);
  assert.equal(isChatGptConversationRequest('https://chatgpt.com/backend-api/f/conversation/prepare', 'POST'), false);
  assert.equal(isChatGptConversationRequest('https://chatgpt.com/backend-api/conversation/init', 'POST'), false);
  assert.equal(isChatGptConversationRequest('https://chatgpt.com/backend-api/messages', 'POST'), false);
  assert.equal(isChatGptConversationRequest('https://evil.example/backend-api/conversation', 'POST'), false);
  assert.equal(isChatGptConversationRequest('https://chatgpt.com/backend-api/conversation', 'GET'), false);
});

test('missing metadata remains missing instead of being invented', () => {
  const result = extractResponseEvidence({ body: '{"status":"ok"}' });
  assert.equal(result.model, null);
  assert.equal(result.reasoning, null);
  assert.deepEqual(result.conflicts, { model: false, reasoning: false });
  assert.equal(result.diagnostics.bodyFormat, 'json');
  assert.equal(result.diagnostics.modelCandidateCount, 0);
});

test('diagnoses empty and unparseable response bodies without retaining content', () => {
  const empty = extractResponseEvidence({ body: '', mimeType: 'text/event-stream' });
  assert.deepEqual(empty.diagnostics, {
    mimeType: 'text/event-stream',
    bodyLength: 0,
    bodyFormat: 'empty',
    parsedObjectCount: 0,
    modelCandidateCount: 0,
    reasoningCandidateCount: 0,
    modelCandidatePaths: [],
    reasoningCandidatePaths: [],
    modelCandidateValues: [],
    reasoningCandidateValues: [],
    matchedHeaderFields: [],
  });
  const unparsed = extractResponseEvidence({ body: 'not-json', mimeType: 'text/plain' });
  assert.equal(unparsed.diagnostics.bodyFormat, 'unparsed');
  assert.equal(unparsed.diagnostics.bodyLength, 8);
});

test('normalizes the observed Sol transport alias but keeps thinking independent', () => {
  assert.equal(extractRequestEvidence('{"model":"gpt-5.6-sol-wm"}').model, 'gpt-5.6-sol');
  assert.equal(extractRequestEvidence('{"model":"gpt-5-6-thinking"}').model, 'gpt-5-6-thinking');
});

test('rewrites a disallowed top-level model to the known Sol transport id', () => {
  const result = rewriteConversationPostData(
    JSON.stringify({ model: 'gpt-5-6-thinking', messages: [{ content: 'keep me' }] }),
    { lockedModels: ['gpt-5.6-sol'], allowedReasoningLevels: ['high'], preferredReasoning: 'high' },
  );
  assert.equal(result.changed, true);
  assert.equal(result.modelBefore, 'gpt-5-6-thinking');
  assert.equal(result.modelAfter, 'gpt-5.6-sol');
  assert.equal(result.transportModelAfter, 'gpt-5.6-sol-wm');
  assert.deepEqual(JSON.parse(result.postData).messages, [{ content: 'keep me' }]);
});

test('preserves an already allowed Sol transport alias instead of rewriting it', () => {
  const source = JSON.stringify({ model: 'gpt-5.6-sol-wm' });
  const result = rewriteConversationPostData(source, {
    lockedModels: ['gpt-5.6-sol', 'gpt-5.5'],
    allowedReasoningLevels: ['high'],
    preferredReasoning: 'high',
  });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'already_locked');
  assert.equal(result.postData, source);
});

test('rewrites only existing top-level reasoning fields to the preferred allowed level', () => {
  const result = rewriteConversationPostData(
    JSON.stringify({ model: 'gpt-5.6-sol-wm', reasoning_effort: 'low', metadata: { reasoning_effort: 'low' } }),
    {
      lockedModels: ['gpt-5.6-sol'],
      allowedReasoningLevels: ['medium', 'high'],
      preferredReasoning: 'high',
    },
  );
  const parsed = JSON.parse(result.postData);
  assert.equal(parsed.reasoning_effort, 'high');
  assert.equal(parsed.metadata.reasoning_effort, 'low');
  assert.deepEqual(result.reasoningFields, ['reasoning_effort']);
});

test('does not invent absent reasoning fields while locking the model', () => {
  const result = rewriteConversationPostData(
    JSON.stringify({ model: 'gpt-5-6-thinking', metadata: { reasoning_effort: 'low' } }),
    {
      lockedModels: ['gpt-5.6-sol'],
      allowedReasoningLevels: ['high'],
      preferredReasoning: 'high',
    },
  );
  const parsed = JSON.parse(result.postData);
  assert.equal(Object.hasOwn(parsed, 'reasoning_effort'), false);
  assert.equal(parsed.metadata.reasoning_effort, 'low');
});

test('fails open for invalid JSON or a missing top-level model field', () => {
  const invalid = rewriteConversationPostData('not-json', { lockedModels: ['gpt-5.6-sol'] });
  assert.equal(invalid.changed, false);
  assert.equal(invalid.reason, 'request_body_not_json_object');
  const missing = rewriteConversationPostData('{"metadata":{"model":"gpt-5.5"}}', {
    lockedModels: ['gpt-5.6-sol'],
  });
  assert.equal(missing.changed, false);
  assert.equal(missing.reason, 'top_level_model_missing');
});


test('extracts ChatGPT stream handoff and matches downstream topic or resume token', () => {
  const token = 'resume-token-1234567890';
  const body = [
    'event: delta_encoding',
    'data: "v1"',
    '',
    `data: {"type":"resume_conversation_token","kind":"topic","token":"${token}","conversation_id":"conv-12345678"}`,
    '',
    'data: {"type":"stream_handoff","conversation_id":"conv-12345678","turn_exchange_id":"turn-12345678","options":[{"type":"resume_sse_endpoint","topic_id":"conversation-turn-topic-12345678"},{"type":"subscribe_ws_topic","topic_id":"conversation-turn-topic-12345678"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const handoff = extractStreamHandoff(body);
  assert.equal(handoff.conversationId, 'conv-12345678');
  assert.equal(handoff.turnExchangeId, 'turn-12345678');
  assert.deepEqual(handoff.topicIds, ['conversation-turn-topic-12345678']);
  assert.equal(handoff.resumeToken, token);
  assert.equal(streamPayloadMatches(`subscribe:${handoff.topicIds[0]}`, handoff), true);
  assert.equal(streamPayloadMatches(`https://chatgpt.com/stream?token=${token}`, handoff), true);
  assert.equal(streamPayloadMatches('unrelated-topic', handoff), false);
  assert.deepEqual(publicStreamHandoff(handoff), {
    conversationId: 'conv-12345678',
    turnExchangeId: 'turn-12345678',
    topicIds: ['conversation-turn-topic-12345678'],
    transports: ['resume_sse_endpoint', 'subscribe_ws_topic'],
    resumeTokenPresent: true,
  });
});

test('extracts model and thinking effort from nested ChatGPT WebSocket encoded_item SSE', () => {
  const encodedItem = [
    'event: delta',
    'data: {\"v\":{\"message\":{\"author\":{\"role\":\"assistant\"},\"metadata\":{\"resolved_model_slug\":\"gpt-5-6\",\"model_slug\":\"gpt-5-6\",\"default_model_slug\":\"gpt-5.6-sol-wm\",\"thinking_effort\":\"extended\"}}}}',
    '',
  ].join('\n');
  const body = JSON.stringify([{ type: 'message', topic_id: 'conversation-turn-test', payload: { type: 'conversation-turn-stream', payload: { type: 'stream-item', encoded_item: encodedItem } } }]);
  const result = extractResponseEvidence({ body, mimeType: 'application/json' });
  assert.equal(result.model, 'gpt-5.6-sol');
  assert.equal(result.reasoning, 'high');
  assert.match(result.diagnostics.bodyFormat, /embedded-sse/);
  assert.match(result.fields.model, /resolved_model_slug/);
  assert.match(result.fields.reasoning, /thinking_effort/);
});