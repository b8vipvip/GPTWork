import test from 'node:test';
import assert from 'node:assert/strict';

import { extractResponseEvidence } from '../network-evidence.js';
import {
  ChatGptNetworkMonitor,
  hasCompleteResponseEvidence,
  hasResponseMetadataEvidence,
  webSocketFrameMatchesHandoff,
} from '../network-monitor.js';

function embeddedFrame(metadata) {
  const encoded = `event: delta\ndata: ${JSON.stringify({
    v: {
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['ok'] },
        metadata,
      },
    },
  })}\n\n`;
  return JSON.stringify([{
    type: 'message',
    topic_id: 'conversation-turn-turn-12345678',
    payload: {
      type: 'conversation-turn-stream',
      payload: {
        type: 'stream-item',
        conversation_id: 'conversation-12345678',
        turn_id: 'turn-12345678',
        encoded_item: encoded,
      },
    },
  }]);
}

test('explicit resolved served-model authority wins over weaker model_slug/default metadata', () => {
  const evidence = extractResponseEvidence({
    body: embeddedFrame({
      resolved_model_slug: 'gpt-5-6-auto-thinking',
      model_slug: 'gpt-5-6',
      default_model_slug: 'gpt-5.6-sol-wm',
      thinking_effort: 'extended',
    }),
    mimeType: 'application/json',
  });

  assert.equal(evidence.model, 'gpt-5-6-auto-thinking');
  assert.equal(evidence.reasoning, 'high');
  assert.equal(evidence.conflicts.model, false);
  assert.deepEqual(
    new Set(evidence.diagnostics.modelCandidateValues),
    new Set(['gpt-5-6-auto-thinking']),
  );
  assert.equal(hasCompleteResponseEvidence(evidence), true);
});

test('consistent disallowed backend model remains complete evidence', () => {
  const evidence = extractResponseEvidence({
    body: embeddedFrame({
      resolved_model_slug: 'gpt-5.5',
      model_slug: 'gpt-5.5',
      default_model_slug: 'gpt-5.5',
      thinking_effort: 'high',
    }),
    mimeType: 'application/json',
  });

  assert.equal(evidence.model, 'gpt-5.5');
  assert.equal(evidence.reasoning, 'high');
  assert.equal(evidence.conflicts.model, false);
  assert.equal(hasCompleteResponseEvidence(evidence), true);
});

test('model-only response metadata is retained even when reasoning is not exposed', () => {
  const evidence = extractResponseEvidence({
    body: embeddedFrame({
      resolved_model_slug: 'gpt-6-astra',
      model_slug: 'gpt-6-astra',
    }),
    mimeType: 'application/json',
  });

  assert.equal(evidence.model, 'gpt-6-astra');
  assert.equal(evidence.reasoning, null);
  assert.equal(hasResponseMetadataEvidence(evidence), true);
  assert.equal(hasCompleteResponseEvidence(evidence), false);
});

test('metadata-empty control frames are not verification-bearing evidence', () => {
  const evidence = extractResponseEvidence({
    body: JSON.stringify([{ type: 'reply', reply: { type: 'unsubscribe' } }]),
    mimeType: 'application/json',
  });

  assert.equal(evidence.model, null);
  assert.equal(evidence.reasoning, null);
  assert.equal(hasCompleteResponseEvidence(evidence), false);
});

test('websocket verification requires a marker from the exact handoff', () => {
  const handoff = {
    conversationId: 'conversation-12345678',
    turnExchangeId: 'turn-12345678',
    topicIds: ['conversation-turn-turn-12345678'],
    resumeToken: 'resume-token-12345678',
  };

  assert.equal(
    webSocketFrameMatchesHandoff(
      JSON.stringify({ topic_id: 'conversation-turn-turn-12345678', payload: 'delta' }),
      handoff,
    ),
    true,
  );
  assert.equal(
    webSocketFrameMatchesHandoff(
      JSON.stringify({ topic_id: 'conversation-turn-other-99999999', payload: 'delta' }),
      handoff,
    ),
    false,
  );
});


test('private response routing can reuse initial SSE handoff correlation', () => {
  const monitor = Object.create(ChatGptNetworkMonitor.prototype);
  monitor.handoffs = new Map();
  monitor.onStreamData = () => {};
  const body = [
    `data: ${JSON.stringify({ type: 'resume_conversation_token', token: 'resume-token-12345678', conversation_id: 'conversation-12345678' })}`,
    `data: ${JSON.stringify({ type: 'stream_handoff', conversation_id: 'conversation-12345678', turn_exchange_id: 'turn-12345678', options: [{ type: 'websocket', topic_id: 'conversation-turn-turn-12345678' }] })}`,
    '',
  ].join('\n\n');
  const record = {
    tabId: 7,
    requestId: 'initial-request',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    mimeType: 'text/event-stream',
    downstream: false,
  };

  const handoff = monitor.resolveFinishedHandoff(7, record, body);
  assert.ok(handoff);
  assert.equal(handoff.conversationId, 'conversation-12345678');
  assert.equal(handoff.turnExchangeId, 'turn-12345678');
  assert.equal(monitor.newestHandoff(7)?.id, handoff.id);

  const downstream = {
    ...record,
    requestId: 'downstream-request',
    downstream: true,
    downstreamCandidate: true,
    handoffId: null,
    url: 'https://chatgpt.com/backend-api/conversation/stream',
  };
  const matched = monitor.resolveFinishedHandoff(
    7,
    downstream,
    JSON.stringify({ topic_id: 'conversation-turn-turn-12345678' }),
  );
  assert.equal(matched?.id, handoff.id);
  assert.equal(
    monitor.downstreamResponseMatchesHandoff(
      downstream,
      JSON.stringify({ topic_id: 'conversation-turn-turn-12345678' }),
      matched,
    ),
    true,
  );
});
