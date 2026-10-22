import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ChatGptNetworkMonitor } from '../network-monitor.js';

const [background, content] = await Promise.all(
  ['background.js', 'content.js']
    .map((name) => readFile(new URL('../' + name, import.meta.url), 'utf8')),
);

test('records first native model, subsequent transitions, and picker provenance', () => {
  assert.match(background, /first_concrete_page_model_observed/);
  assert.match(background, /page_model_display_transition/);
  assert.match(background, /official_picker_a_user_action/);
  assert.match(background, /automated: message\.automated === true/);
  assert.match(content, /GPTLOCK_MODEL_PICKER_ACTION/);
  assert.match(content, /nativePickerOpenedAt/);
  assert.match(content, /if \(event\.isTrusted !== true\) return/);
});

test('network lifecycle is observed with request correlation, no headers or bodies in event payload', async () => {
  const oldChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { lastError: null },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
      sendCommand(_target, method, _args, callback) {
        if (method === 'Network.getResponseBody') {
          callback({ body: JSON.stringify({ message: { metadata: { resolved_model_slug: 'gpt-6' } } }), base64Encoded: false });
        } else callback({ bufferedData: '' });
      },
    },
  };
  try {
    const events = [];
    const evidence = [];
    const monitor = new ChatGptNetworkMonitor({
      onProtocolEvent(_tabId, event) { events.push(event); },
      onEvidence(_tabId, item) { evidence.push(item); },
    });
    const record = {
      tabId: 123,
      requestId: '7340.738',
      startedAt: Date.now() - 1000,
      url: 'https://chatgpt.com/backend-api/f/conversation',
      endpoint: '/backend-api/f/conversation',
      mimeType: '',
      responseHeaders: {},
      responseVerificationEnabled: true,
      downstream: false,
    };
    monitor.requests.set(monitor.key(123, record.requestId), record);
    await monitor.handleResponse(123, {
      requestId: record.requestId,
      response: { mimeType: 'text/event-stream', status: 200, headers: {} },
    });
    await monitor.handleFinished(123, { requestId: record.requestId, encodedDataLength: 1234 });
    assert.deepEqual(events.map((item) => item.event), [
      'conversation_response_headers', 'conversation_response_finished',
    ]);
    assert.equal(events[0].requestId, '7340.738');
    assert.equal(events[0].transportRequestId, '7340.738');
    assert.equal(events[0].httpStatus, 200);
    assert.equal(events[1].encodedDataLength, 1234);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].model, 'gpt-6');
    assert.ok(!('body' in events[0]));
    assert.ok(!('headers' in events[0]));
    assert.ok(!('postData' in events[0]));
  } finally {
    globalThis.chrome = oldChrome;
  }
});

test('network loading failure is logged even if the response cannot be parsed', async () => {
  const oldChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { lastError: null },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  try {
    const events = [];
    const failures = [];
    const monitor = new ChatGptNetworkMonitor({
      onProtocolEvent(_tabId, event) { events.push(event); },
      onFailure(_tabId, item) { failures.push(item); },
    });
    monitor.requests.set(monitor.key(123, '7340.738'), {
      tabId: 123, requestId: '7340.738', startedAt: Date.now(),
      endpoint: '/backend-api/f/conversation', responseVerificationEnabled: true,
      downstream: false,
    });
    await monitor.handleFailed(123, { requestId: '7340.738', canceled: true, errorText: 'net::ERR_ABORTED' });
    assert.equal(events[0].event, 'conversation_response_failed');
    assert.equal(events[0].requestId, '7340.738');
    assert.equal(events[0].networkError, 'net::ERR_ABORTED');
    assert.equal(failures.length, 1);
  } finally {
    globalThis.chrome = oldChrome;
  }
});
