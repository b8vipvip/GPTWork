import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, access } from 'node:fs/promises';
import { ChatGptNetworkMonitor } from '../network-monitor.js';
import { rewriteConversationPostData } from '../network-evidence.js';
import {
  ASTRA_DEBUG_TRANSPORT, ASTRA_DEBUG_PROMPT, isAstraDebugRequest, detectAstraDebugSseTerminal, astraDebugConfiguration,
  astraDebugVerdict, publicAstraDebugProbe,
} from '../astra-debug-probe.js';

const base = {
  lockedModels: ['gpt-6'],
  knownModels: ['gpt-6'],
  preferredReasoning: 'high',
  allowedReasoningLevels: ['high'],
  responseVerificationEnabled: true,
};
const active = { phase: 'dispatching', claimed: false, startedAt: Date.now() };

test('debug-only override uses exact Astra transport, keeps reasoning and other request fields', () => {
  const config = astraDebugConfiguration(base, active);
  assert.equal(config.authorityKind, 'debug-astra-transport');
  assert.equal(config.forceTransportModel, ASTRA_DEBUG_TRANSPORT);
  const input = { model: 'gpt-6', reasoning_effort: 'high', messages: [{ content: { parts: ['PRIVATE'] } }] };
  const rewritten = rewriteConversationPostData(JSON.stringify(input), config);
  const payload = JSON.parse(rewritten.postData);
  assert.equal(rewritten.changed, true);
  assert.equal(payload.model, ASTRA_DEBUG_TRANSPORT);
  assert.equal(payload.reasoning_effort, 'high');
  assert.deepEqual(payload.messages, input.messages);
  assert.equal(astraDebugConfiguration(base, { ...active, claimed: true }), null);
  assert.equal(astraDebugConfiguration(base, { ...active, claimed: true,
    claimedFetchRequestId: 'fetch-1' }, 'fetch-1').forceTransportModel, ASTRA_DEBUG_TRANSPORT);
  assert.equal(astraDebugConfiguration(base, { ...active, claimed: true,
    claimedFetchRequestId: 'fetch-1' }, 'fetch-2'), null);
  assert.equal(astraDebugConfiguration(base, { ...active, phase: 'finished' }), null);
});

test('debug request ownership matches only the exact fixed prompt', () => {
  assert.equal(isAstraDebugRequest(JSON.stringify({
    messages: [{ author: { role: 'user' }, content: { parts: [ASTRA_DEBUG_PROMPT] } }],
  })), true);
  assert.equal(isAstraDebugRequest(JSON.stringify({
    messages: [{ author: { role: 'user' }, content: { parts: ['UNRELATED'] } }],
  })), false);
  assert.equal(isAstraDebugRequest(JSON.stringify({
    messages: [{ author: { role: 'assistant' }, content: { parts: [ASTRA_DEBUG_PROMPT] } }],
  })), false);
  assert.equal(isAstraDebugRequest(JSON.stringify({
    messages: [
      { author: { role: 'user' }, content: { parts: [ASTRA_DEBUG_PROMPT] } },
      { author: { role: 'user' }, content: { parts: ['Different new message'] } },
    ],
  })), false, 'historical prompt cannot claim a new turn');
  assert.equal(isAstraDebugRequest(JSON.stringify({
    messages: [{ author: { role: 'user' }, content: { parts: [ASTRA_DEBUG_PROMPT, 'attachment'] } }],
  })), false, 'additional parts must not claim a fixed-message test');
});

test('SSE done detection distinguishes a true terminal marker from plain HTTP completion', () => {
  assert.equal(detectAstraDebugSseTerminal('event: message\ndata: {"text":"hello"}\n'), false);
  assert.equal(detectAstraDebugSseTerminal('data: [DONE]\n\n'), true);
  assert.equal(detectAstraDebugSseTerminal('event: message_stream_complete\ndata: {}\n'), true);
  assert.equal(detectAstraDebugSseTerminal(null), false);
});

test('transport success, authoritative Astra proof, mismatch and missing proof stay independent', () => {
  const baseProbe = { forwardedTransportModel: ASTRA_DEBUG_TRANSPORT,
    httpStatus: 200, terminalEvent: 'conversation_response_finished' };
  assert.deepEqual(astraDebugVerdict(baseProbe), {
    requestAccepted: true, httpSuccess: true, responseCompleted: true,
    requestOutcome: 'transport_completed', modelVerdict: 'unverified',
  });
  assert.equal(astraDebugVerdict({ ...baseProbe, responseModel: 'gpt-6-astra' }).modelVerdict, 'astra_confirmed');
  assert.equal(astraDebugVerdict({ ...baseProbe, responseModel: 'gpt-6' }).modelVerdict, 'unverified');
  assert.equal(astraDebugVerdict({ ...baseProbe, responseModel: 'gpt-6-sol' }).modelVerdict, 'different_model');
  assert.equal(astraDebugVerdict({ ...baseProbe, httpStatus: 403 }).requestOutcome, 'failed');
  assert.equal(astraDebugVerdict({ ...baseProbe, terminalEvent: 'conversation_response_failed' }).requestOutcome, 'failed');
  const publicProbe = publicAstraDebugProbe({ ...baseProbe, id: 'test', prompt: 'SECRET', responseText: 'SECRET' });
  assert.equal(JSON.stringify(publicProbe).includes('SECRET'), false);
});

test('Fetch requestPaused performs one exact one-shot Astra POST and reverts to ordinary policy', async () => {
  const oldChrome = globalThis.chrome;
  const calls = [];
  const probe = { ...active };
  globalThis.chrome = {
    runtime: { lastError: null },
    debugger: {
      onEvent: { addListener() {} }, onDetach: { addListener() {} },
      attach(_target, _version, cb) { cb(); },
      sendCommand(_target, method, args, cb) { calls.push({ method, args }); cb({}); },
    },
  };
  try {
    const rewrites = [];
    const monitor = new ChatGptNetworkMonitor({
      getLockConfiguration: () => base,
      getDebugProbe: () => probe,
      claimDebugProbe(_tabId, fetchRequestId, postData) {
        if (!isAstraDebugRequest(postData) || probe.claimed) return null;
        probe.claimed = true;
        probe.claimedFetchRequestId = fetchRequestId;
        return probe;
      },
      onStatus() {},
      onRewrite(_tabId, rewrite) { rewrites.push(rewrite); if (rewrite.authorityKind === 'debug-astra-transport') probe.claimed = true; },
    });
    await monitor.attach(77);
    const url = 'https://chatgpt.com/backend-api/conversation';
    const payload = JSON.stringify({ model: 'gpt-6', reasoning_effort: 'high',
      messages: [{ author: { role: 'user' }, content: { parts: [ASTRA_DEBUG_PROMPT] } }] });
    await monitor.handlePausedRequest(77, {
      requestId: 'fetch-1', networkId: 'net-1',
      request: { url, method: 'POST', postData: payload },
    });
    const first = calls.find((entry) => entry.method === 'Fetch.continueRequest');
    assert.equal(JSON.parse(Buffer.from(first.args.postData, 'base64').toString()).model, ASTRA_DEBUG_TRANSPORT);
    assert.equal(rewrites[0].authorityKind, 'debug-astra-transport');
    assert.equal(rewrites[0].transportModelAfter, ASTRA_DEBUG_TRANSPORT);
    await monitor.handlePausedRequest(77, {
      requestId: 'fetch-2', networkId: 'net-2',
      request: { url, method: 'POST', postData: payload },
    });
    assert.equal(rewrites[1].authorityKind, 'normal-policy');
    assert.equal(rewrites[1].transportModelAfter, 'gpt-6');
  } finally { globalThis.chrome = oldChrome; }
});

test('debug request missing a model fails closed rather than forwarding normal model', async () => {
  const oldChrome = globalThis.chrome;
  const calls = [];
  globalThis.chrome = {
    runtime: { lastError: null },
    debugger: {
      onEvent: { addListener() {} }, onDetach: { addListener() {} },
      sendCommand(_target, method, args, cb) { calls.push({ method, args }); cb({}); },
    },
  };
  try {
    const monitor = new ChatGptNetworkMonitor({
      getLockConfiguration: () => base,
      getDebugProbe: () => active,
      onRewrite() {},
    });
    await monitor.handlePausedRequest(77, {
      requestId: 'fetch-invalid', networkId: 'net-invalid',
      request: { url: 'https://chatgpt.com/backend-api/conversation', method: 'POST',
        postData: JSON.stringify({ messages: [] }) },
    });
    assert.equal(calls.some((entry) => entry.method === 'Fetch.failRequest'), true);
    assert.equal(calls.some((entry) => entry.method === 'Fetch.continueRequest'), false);
  } finally { globalThis.chrome = oldChrome; }
});

test('popup debug entry, tools catalog, message authorization and release metadata are wired', async () => {
  const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
  const [popup, navigation, background, content, ui, script, manifestText] = await Promise.all([
    read('popup-v0513.html'), read('popup-navigation.js'), read('background.js'),
    read('content.js'), read('debug-tools.html'), read('debug-tools.js'), read('manifest.json'),
  ]);
  assert.match(popup, /id="debugTools"/);
  assert.match(navigation, /debug-tools\.html/);
  assert.match(background, /GPTWORK_DEBUG_ASTRA_START/);
  assert.match(background, /astra_debug_response_model_evidence/);
  assert.match(background, /debug_pointer_action_not_authorized/);
  assert.match(content, /GPTWORK_DEBUG_ASTRA_SEND_PROBE/);
  assert.match(ui, /gpt-6-astra-wm/);
  assert.match(script, /GPTWORK_DEBUG_ASTRA_STATUS/);
  const files = [
    'Analyze-GPTWork-Jank.ps1',
    'GPTWork-Jank-Diagnostic.ps1',
    'Run-GPTWork-Jank-Analyzer.bat',
    'Run-GPTWork-Jank-Diagnostic.bat',
    'Run-GPTWork-Jank-ETW-Diagnostic.bat',
  ];
  for (const file of files) {
    assert.ok(script.includes(file));
    await access(new URL('../../tools/windows/' + file, import.meta.url));
  }
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.version, '0.5.244');
});
