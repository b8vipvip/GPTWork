import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  modelOriginScene, conversationKeyFromUrl, originMetadataEndpoint,
  extractOriginConversationMetadata, originSnapshotFields,
  ORIGIN_METADATA_MAX_BYTES,
} from '../astra-origin-trace.js';
import { ChatGptNetworkMonitor } from '../network-monitor.js';

const conversation = '6ad4bc3e-cbfc-83e8-a62d-7ad63b8c80c7';
const key = 'conversation:' + conversation;
const detailUrl = 'https://chatgpt.com/backend-api/conversation/' + conversation;
const pageUrl = 'https://chatgpt.com/g/g-p-example-chat2api/c/' + conversation;

test('Astra/non-Astra/unknown states are separate, including an unhydrated composer', () => {
  assert.equal(modelOriginScene('gpt-6-astra'), 'astra');
  assert.equal(modelOriginScene('gpt-6'), 'non_astra');
  assert.equal(modelOriginScene('gpt-5.6-sol'), 'non_astra');
  assert.equal(modelOriginScene(null), 'unknown');
  assert.equal(modelOriginScene('untrusted random text'), 'unknown');
  const snapshot = originSnapshotFields({
    model: 'gpt-6-astra', modelEvidenceSource: 'composer-current-display',
    pickerA: { observed: true, models: ['gpt-6', 'gpt-5.6-sol'], selectedModel: null },
    originTrace: {
      documentTimeOrigin: 1780000000000, sinceNavigationMs: 1200,
      readyState: 'complete', navigationType: 'reload',
      composerPresent: true, modelTriggerPresent: true,
    },
  });
  assert.equal(snapshot.scene, 'astra');
  assert.equal(snapshot.navigationType, 'reload');
  assert.equal(snapshot.pickerASelectedModel, null);
  assert.equal(snapshot.documentTimeOrigin, 1780000000000);
});

test('metadata endpoint is only the current conversation detail GET', () => {
  assert.equal(conversationKeyFromUrl(pageUrl), key);
  assert.equal(conversationKeyFromUrl('https://evil.com/c/' + conversation), null);
  assert.equal(originMetadataEndpoint(detailUrl, 'GET')?.conversationKey, key);
  assert.equal(originMetadataEndpoint(detailUrl, 'POST'), null);
  assert.equal(originMetadataEndpoint('https://chatgpt.com/backend-api/conversations', 'GET'), null);
  assert.equal(originMetadataEndpoint('https://evil.com/backend-api/conversation/' + conversation, 'GET'), null);
});

test('conversation hydration extracts allowlisted model metadata only, not user content', () => {
  const data = {
    default_model_slug: 'gpt-6-astra-wm',
    title: 'PRIVATE TITLE',
    current_node: 'node-1',
    mapping: {
      'node-1': { message: { content: { parts: ['PRIVATE PROMPT'] }, metadata: { model_slug: 'gpt-6-astra-wm' } } },
      'node-2': { message: { content: { parts: ['PRIVATE REPLY'] }, metadata: { model_slug: 'gpt-5.6-sol-wm' } } },
    },
  };
  const result = extractOriginConversationMetadata(JSON.stringify(data));
  assert.equal(result.status, 'parsed');
  assert.deepEqual(result.fields, [
    { scope: 'conversation', field: 'default_model_slug', model: 'gpt-6-astra-wm' },
    { scope: 'current_node_message_metadata', field: 'model_slug', model: 'gpt-6-astra-wm' },
  ]);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(extractOriginConversationMetadata('x'.repeat(ORIGIN_METADATA_MAX_BYTES + 1)).status, 'size_limit');
  assert.equal(extractOriginConversationMetadata('not json').status, 'invalid_json');
});

function chromeMock(commands) {
  return {
    runtime: { lastError: null },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
      attach(_target, _version, cb) { commands.push('attach'); cb(); },
      detach(_target, cb) { commands.push('detach'); cb(); },
      sendCommand(_target, method, _params, cb) {
        commands.push(method);
        if (method === 'Network.getResponseBody') {
          cb({
            body: JSON.stringify({ default_model_slug: 'gpt-6-astra-wm', messages: ['PRIVATE'] }),
            base64Encoded: false,
          });
        } else cb({});
      },
    },
  };
}

test('automatic CDP trace captures conversation detail GET and response without exporting body', async () => {
  const oldChrome = globalThis.chrome;
  const commands = [];
  globalThis.chrome = chromeMock(commands);
  try {
    const trace = [];
    const monitor = new ChatGptNetworkMonitor({
      onOriginTrace(_tabId, event) { trace.push(event); },
      onStatus() {},
    });
    assert.equal(await monitor.enableOriginTrace(91), true);
    assert.equal(monitor.hasOriginTrace(91), true);
    assert.equal(monitor.hasResponseCapture(91), false);
    const id = '7340.738';
    await monitor.handleEvent({ tabId: 91 }, 'Network.requestWillBeSent', {
      requestId: id, request: { url: detailUrl, method: 'GET' },
    });
    await monitor.handleEvent({ tabId: 91 }, 'Network.responseReceived', {
      requestId: id, response: { url: detailUrl, status: 200, mimeType: 'application/json',
        headers: { 'Content-Length': '130' } },
    });
    await monitor.handleEvent({ tabId: 91 }, 'Network.loadingFinished', {
      requestId: id, encodedDataLength: 130,
    });
    assert.deepEqual(trace.map((item) => item.event), [
      'metadata_request', 'metadata_response', 'metadata_finished',
    ]);
    assert.equal(trace[2].metadata.fields[0].model, 'gpt-6-astra-wm');
    assert.equal(JSON.stringify(trace).includes('PRIVATE'), false);
    assert.equal(commands.includes('Network.getResponseBody'), true);
    await monitor.enableResponseCapture(91);
    await monitor.disableResponseCapture(91);
    assert.equal(commands.includes('Network.disable'), false);
    await monitor.disableOriginTrace(91);
    assert.equal(commands.includes('Network.disable'), true);
  } finally {
    globalThis.chrome = oldChrome;
  }
});

test('background and manifest register automatic document and model state diagnostics', async () => {
  const [background, manifest, content] = await Promise.all([
    readFile(new URL('../background.js', import.meta.url), 'utf8'),
    readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('../content.js', import.meta.url), 'utf8'),
  ]);
  assert.match(background, /astra_origin_navigation_started/);
  assert.match(background, /astra_origin_model_snapshot/);
  assert.match(background, /astra_origin_conversation_hydration/);
  assert.match(background, /astra_origin_served_model_evidence/);
  assert.match(background, /astra_origin_capture_arm_result/);
  assert.match(background, /rememberAstraConversation/);
  assert.match(content, /originTraceSnapshot/);
  const manifestJson = JSON.parse(manifest);
  assert.equal(manifestJson.content_scripts[1].run_at, 'document_start');
  assert.deepEqual(manifestJson.content_scripts[1].js, ['astra-origin-early.js']);
});
