import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { recordResponseStreamActivity } from '../response-stream-activity.js';

test('response activity refreshes only the exact current waiting request', () => {
  const state = {
    phase: 'waiting',
    lastRequest: { requestId: 'request-1' },
    streamTracking: null,
  };

  assert.equal(recordResponseStreamActivity(state, {
    event: 'conversation_response_activity',
    requestId: 'request-1',
    transport: 'sse',
  }, 1000), true);
  assert.deepEqual(state.streamTracking, {
    detectedAt: 1000,
    lastActivityAt: 1000,
    downstreamEvidenceCount: 0,
    transports: ['sse'],
    handoff: null,
  });

  assert.equal(recordResponseStreamActivity(state, {
    event: 'conversation_response_activity',
    requestId: 'old-request',
    transport: 'websocket',
  }, 5000), false);
  assert.equal(state.streamTracking.lastActivityAt, 1000,
    'late activity from a superseded request must not extend the current deadline');

  assert.equal(recordResponseStreamActivity(state, {
    event: 'conversation_response_activity',
    requestId: 'request-1',
    transport: 'websocket',
  }, 2000), true);
  assert.equal(state.streamTracking.lastActivityAt, 2000);
  assert.deepEqual(state.streamTracking.transports, ['sse', 'websocket']);
  assert.equal(state.streamTracking.downstreamEvidenceCount, 0,
    'byte activity is not response-model evidence');
});

test('non-waiting, wrong-event and invalid activity cannot mutate stream tracking', () => {
  const state = { phase: 'verified', lastRequest: { requestId: 'request-1' }, streamTracking: null };
  assert.equal(recordResponseStreamActivity(state, {
    event: 'conversation_response_activity', requestId: 'request-1', transport: 'sse',
  }, 1000), false);
  assert.equal(recordResponseStreamActivity(state, {
    event: 'conversation_response_finished', requestId: 'request-1', transport: 'sse',
  }, 1000), false);
  assert.equal(recordResponseStreamActivity({ ...state, phase: 'waiting' }, {
    event: 'conversation_response_activity', requestId: 'request-1', transport: 'sse',
  }, Number.NaN), false);
  assert.equal(state.streamTracking, null);
});

test('Network.dataReceived reports correlated activity even when CDP exposes byte counts only', async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { lastError: null },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  try {
    const { ChatGptNetworkMonitor } = await import(`../network-monitor.js?stream-activity-${Date.now()}`);
    const events = [];
    const monitor = new ChatGptNetworkMonitor({
      onProtocolEvent: (tabId, protocol) => events.push({ tabId, ...protocol }),
    });
    const handoffId = monitor.key(7, 'initial-request');
    monitor.handoffs.set(handoffId, {
      id: handoffId,
      tabId: 7,
      initialRequestId: 'initial-request',
      startedAt: Date.now(),
      conversationId: 'conversation-1',
      topicIds: ['topic-1'],
    });
    monitor.requests.set(monitor.key(7, 'downstream-request'), {
      requestId: 'downstream-request',
      endpoint: '/backend-api/conversation/stream',
      mimeType: 'text/event-stream',
      downstream: true,
      handoffId,
      streamCaptureStarted: false,
    });

    monitor.handleDataReceived(7, {
      requestId: 'downstream-request',
      dataLength: 128,
      encodedDataLength: 96,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'conversation_response_activity');
    assert.equal(events[0].requestId, 'initial-request');
    assert.equal(events[0].transportRequestId, 'downstream-request');
    assert.equal(events[0].downstream, true);
    assert.equal(events[0].transport, 'sse');
    assert.equal(events[0].dataLength, 128);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('associated WebSocket frames refresh activity without becoming model evidence', async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { lastError: null },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  try {
    const { ChatGptNetworkMonitor } = await import(`../network-monitor.js?websocket-activity-${Date.now()}`);
    const events = [];
    const monitor = new ChatGptNetworkMonitor({
      onProtocolEvent: (tabId, protocol) => events.push({ tabId, ...protocol }),
    });
    const handoffId = monitor.key(9, 'initial-request');
    monitor.handoffs.set(handoffId, {
      id: handoffId,
      tabId: 9,
      initialRequestId: 'initial-request',
      startedAt: Date.now(),
      conversationId: 'conversation-2',
      turnExchangeId: 'turn-2',
      topicIds: ['topic-2'],
    });
    monitor.webSockets.set(monitor.key(9, 'socket-1'), {
      tabId: 9,
      requestId: 'socket-1',
      endpoint: 'websocket',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      handoffId,
    });

    monitor.handleWebSocketFrame(9, {
      requestId: 'socket-1',
      response: { payloadData: 'heartbeat-without-model-metadata' },
    }, 'received');
    monitor.handleWebSocketFrame(9, {
      requestId: 'socket-1',
      response: { payloadData: 'client-heartbeat' },
    }, 'sent');

    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'conversation_response_activity');
    assert.equal(events[0].requestId, 'initial-request');
    assert.equal(events[0].transport, 'websocket');
    assert.equal(events[0].downstream, true);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('background isolates request activity and ignores stale downstream stream callbacks', async () => {
  const [background, network] = await Promise.all([
    readFile(new URL('../background.js', import.meta.url), 'utf8'),
    readFile(new URL('../network-monitor.js', import.meta.url), 'utf8'),
  ]);
  const requestStart = background.indexOf('  onRequest(tabId, request) {');
  const requestEnd = background.indexOf('  onProtocolEvent(tabId, protocol) {', requestStart);
  const requestHandler = background.slice(requestStart, requestEnd);
  const protocolStart = background.indexOf('  onProtocolEvent(tabId, protocol) {');
  const protocolEnd = background.indexOf('  onOriginTrace(tabId, trace) {', protocolStart);
  const protocolHandler = background.slice(protocolStart, protocolEnd);
  const streamStart = background.indexOf('  onStreamData(tabId, streamData) {');
  const streamEnd = background.indexOf('  onFailure(tabId, failure) {', streamStart);
  const streamHandler = background.slice(streamStart, streamEnd);

  assert.match(requestHandler, /state\.streamTracking = null/);
  assert.match(protocolHandler, /recordResponseStreamActivity\(tabStates\.get\(tabId\), protocol\)/);
  assert.match(streamHandler, /initialRequestId === state\.lastRequest\?\.requestId/);
  assert.match(network, /event: 'conversation_response_activity'/);
  assert.match(network, /Network\.dataReceived may contain byte counts without an exposed body chunk/);
  assert.match(network, /const associated = socket\?\.handoffId \? this\.handoffs\.get\(socket\.handoffId\) : null/);
});
