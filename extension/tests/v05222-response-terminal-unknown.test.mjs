import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGptNetworkMonitor } from '../network-monitor.js';

function createHarness(body, { status = 200, downstream = false, handoff = false } = {}) {
  const prior = globalThis.chrome;
  globalThis.chrome = {
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
      sendCommand(_target, command, _params, callback) {
        if (command !== 'Network.getResponseBody') throw new Error(command);
        callback({ body, base64Encoded: false });
      },
    },
    runtime: { lastError: null },
  };
  const observed = [];
  const streamEvents = [];
  const monitor = new ChatGptNetworkMonitor({
    onStatus() {}, onRequest() {}, onFailure() {}, onRewrite() {},
    onEvidence(_tab, evidence) { observed.push(evidence); },
    onStreamData(_tab, event) { streamEvents.push(event); },
    getLockConfiguration() { return { responseVerificationEnabled: true }; },
  });
  monitor.requests.set(monitor.key(33, 'req-1'), {
    requestId: 'req-1',
    endpoint: '/backend-api/conversation',
    responseVerificationEnabled: true,
    mimeType: 'text/event-stream',
    responseHeaders: {},
    status,
    downstream,
    streamCaptureStarted: false,
  });
  if (handoff) monitor.resolveFinishedHandoff = () => ({
    id: 'handoff-1', initialRequestId: 'req-1', startedAt: Date.now(),
  });
  return { monitor, observed, streamEvents, restore() { globalThis.chrome = prior; } };
}

test('completed response without served-model field terminates as unknown, never request-inferred', async () => {
  const body = 'event: message\ndata: {"message":{"metadata":{"model_slug":"gpt-6-thinking"}}}\n\ndata: [DONE]\n\n';
  const h = createHarness(body);
  try {
    await h.monitor.handleFinished(33, { requestId: 'req-1' });
    assert.equal(h.observed.length, 1);
    assert.equal(h.observed[0].model, null);
    assert.equal(h.observed[0].diagnostics.verificationSuppressedReason, 'response_model_not_exposed');
    assert.equal(h.streamEvents.length, 1);
  } finally { h.restore(); }
});

test('genuine resolved-model metadata still confirms its actual response identity', async () => {
  const body = 'event: message\ndata: {"message":{"metadata":{"resolved_model_slug":"gpt-6-thinking","reasoning_effort":"high"}}}\n\ndata: [DONE]\n\n';
  const h = createHarness(body);
  try {
    await h.monitor.handleFinished(33, { requestId: 'req-1' });
    assert.equal(h.observed.length, 1);
    assert.equal(h.observed[0].model, 'gpt-6-thinking');
    assert.equal(h.observed[0].reasoning, 'high');
    assert.equal(h.streamEvents.length, 0);
  } finally { h.restore(); }
});

test('initial stream handoff does not prematurely downgrade a pending downstream response', async () => {
  const h = createHarness('data: {"message":{"metadata":{}}}\n\n', { handoff: true });
  try {
    await h.monitor.handleFinished(33, { requestId: 'req-1' });
    assert.equal(h.observed.length, 0);
    assert.equal(h.streamEvents.length, 1);
  } finally { h.restore(); }
});
