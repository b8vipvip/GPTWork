import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { ChatGptNetworkMonitor } from '../network-monitor.js';
import { ASTRA_DEBUG_PROMPT, ASTRA_DEBUG_TRANSPORT, isAstraDebugRequest } from '../astra-debug-probe.js';
import { buildPrivateRequestPayload, safeRequestEndpoint } from '../private-request-routing.js';

test('Astra one-shot reaches the existing Fetch terminal authority; unrelated requests stay private', async () => {
  const oldChrome = globalThis.chrome;
  const calls = [], rewrites = [], privateEvaluations = [];
  const probe = { phase: 'dispatching', claimed: false, startedAt: Date.now() };
  let privateAvailable = true;
  globalThis.chrome = {
    runtime: { lastError: null },
    debugger: {
      onEvent: { addListener() {} }, onDetach: { addListener() {} },
      sendCommand(_target, method, args, callback) {
        calls.push({ method, args });
        callback({});
      },
    },
  };
  try {
    const source = await readFile(new URL('../private-request-hook.js', import.meta.url), 'utf8');
    const entry = source.indexOf('const PATCH_MARKER =');
    assert.ok(entry >= 0);
    vm.runInNewContext(
      source.slice(entry).replace('export function installPrivateRequestRoutingHook()', 'function installPrivateRequestRoutingHook()'),
      {
        ChatGptNetworkMonitor, isAstraDebugRequest, buildPrivateRequestPayload, safeRequestEndpoint,
        normalizePrivateRequestDecision: (value) => value,
        applyPrivateRequestPatches() { throw new Error('normal passthrough must not be rewritten'); },
        privateCoreChannel: {
          async isAvailable() { return privateAvailable; },
          async windowKeyForTab() { return 'chrome:test'; },
          async request(_operation, payload) {
            privateEvaluations.push(payload);
            return {
              officialConversation: true, changed: false, reason: 'already_locked',
              modelBefore: 'gpt-6', modelAfter: 'gpt-6',
              transportModelBefore: 'gpt-6', transportModelAfter: 'gpt-6',
              reasoningBefore: 'high', reasoningAfter: 'high', reasoningFields: [],
            };
          },
          invalidate() {},
        },
      },
    );
    const monitor = new ChatGptNetworkMonitor({
      getLockConfiguration: () => ({
        lockedModels: ['gpt-6'], knownModels: ['gpt-6'], preferredReasoning: 'high',
        allowedReasoningLevels: ['high'], responseVerificationEnabled: true,
      }),
      getDebugProbe: () => !probe.claimed ? probe : null,
      claimDebugProbe(_tabId, fetchId, postData) {
        if (probe.claimed || !isAstraDebugRequest(postData)) return null;
        probe.claimed = true;
        probe.claimedFetchRequestId = fetchId;
        return probe;
      },
      onRewrite(_tabId, rewrite) { rewrites.push(rewrite); },
    });
    const url = 'https://chatgpt.com/backend-api/conversation';
    const user = (value) => ({ author: { role: 'user' }, content: { parts: [value] } });
    const dispatch = (fetchId, networkId, messages) => monitor.handlePausedRequest(77, {
      requestId: fetchId, networkId,
      request: { url, method: 'POST', postData: JSON.stringify({ model: 'gpt-6', reasoning_effort: 'high', messages }) },
    });
    await dispatch('fetch-normal', 'net-normal', [user('Unrelated')]);
    assert.equal(privateEvaluations.length, 1);
    assert.equal(probe.claimed, false);
    await dispatch('fetch-history', 'net-history', [user(ASTRA_DEBUG_PROMPT), user('Different new turn')]);
    assert.equal(privateEvaluations.length, 2);
    assert.equal(probe.claimed, false);

    privateAvailable = false;
    await dispatch('fetch-astra', 'net-astra', [user(ASTRA_DEBUG_PROMPT)]);
    assert.equal(privateEvaluations.length, 2, 'debug must bypass private-core availability');
    assert.equal(probe.claimedFetchRequestId, 'fetch-astra');
    assert.equal(rewrites.at(-1).authorityKind, 'debug-astra-transport');
    assert.equal(rewrites.at(-1).requestId, 'net-astra');
    const forwarded = calls.find((entry) => entry.method === 'Fetch.continueRequest'
      && entry.args.requestId === 'fetch-astra');
    assert.equal(JSON.parse(Buffer.from(forwarded.args.postData, 'base64').toString()).model, ASTRA_DEBUG_TRANSPORT);

    await dispatch('fetch-repeat', 'net-repeat', [user(ASTRA_DEBUG_PROMPT)]);
    const repeat = calls.find((entry) => entry.method === 'Fetch.continueRequest'
      && entry.args.requestId === 'fetch-repeat');
    assert.ok(repeat);
    assert.equal(repeat.args.postData, undefined);
    assert.equal(rewrites.filter((entry) => entry.authorityKind === 'debug-astra-transport').length, 1);
  } finally {
    globalThis.chrome = oldChrome;
  }
});
