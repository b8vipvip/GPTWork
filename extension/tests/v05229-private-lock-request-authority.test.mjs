import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { buildPrivateRequestPayload, safeRequestEndpoint } from '../private-request-routing.js';

const source = await readFile(new URL('../private-request-hook.js', import.meta.url), 'utf8');
const entry = source.indexOf("const PATCH_MARKER =");
assert.ok(entry >= 0, 'private request hook entrypoint');

test('private terminal request takes the exact tab lock and correlates the formal Fetch event', async () => {
  const observed = { policyTabIds: [], evaluated: [], continued: [], rewrites: [] };
  class Monitor {
    configuration(tabId) {
      observed.policyTabIds.push(tabId);
      assert.equal(tabId, 419, 'policy must never be read without a tabId');
      return { lockedModels: ['gpt-5.6-sol', 'gpt-6'], allowedReasoningLevels: ['high'], preferredReasoning: 'high' };
    }
    verificationTransaction() { return null; }
    async pausedPostData() { return JSON.stringify({ model: 'gpt-6-thinking', thinking_effort: 'high' }); }
    async continuePaused(...args) { observed.continued.push(args); }
    onRewrite(...args) { observed.rewrites.push(args); }
    async handlePausedRequest() { throw new Error('unexpected public fallback'); }
  }
  const privateCoreChannel = {
    async isAvailable() { return true; },
    async windowKeyForTab(tabId) { assert.equal(tabId, 419); return 'chrome:test'; },
    async request(operation, payload) {
      assert.equal(operation, 'evaluate_request');
      observed.evaluated.push(payload);
      return {
        officialConversation: true,
        changed: false,
        reason: 'already_locked',
        modelBefore: 'gpt-6-thinking',
        modelAfter: 'gpt-6-thinking',
        transportModelBefore: 'gpt-6-thinking',
        transportModelAfter: 'gpt-6-thinking',
        reasoningBefore: 'high',
        reasoningAfter: 'high',
        reasoningFields: ['thinking_effort'],
      };
    },
  };
  vm.runInNewContext(source.slice(entry).replace('export function installPrivateRequestRoutingHook()', 'function installPrivateRequestRoutingHook()'), {
    ChatGptNetworkMonitor: Monitor,
    privateCoreChannel, buildPrivateRequestPayload, safeRequestEndpoint,
    normalizePrivateRequestDecision(value) { return value; },
    applyPrivateRequestPatches() { throw new Error('allowed request must not be rewritten'); },
  });
  assert.equal(observed.evaluated.length, 0);
  const monitor = new Monitor();
  await monitor.handlePausedRequest(419, {
    requestId: 'fetch-42', networkId: 'network-42',
    request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST' },
  });
  assert.deepEqual(observed.policyTabIds, [419]);
  assert.deepEqual(observed.evaluated[0].lockedModels, ['gpt-5.6-sol', 'gpt-6']);
  assert.equal(observed.evaluated[0].preferredReasoning, 'high');
  assert.equal(observed.continued.length, 1);
  assert.deepEqual(observed.continued[0].slice(0, 2), [419, 'fetch-42']);
  assert.equal(observed.rewrites.length, 1);
  assert.equal(observed.rewrites[0][1].fetchRequestId, 'fetch-42');
  assert.equal(observed.rewrites[0][1].requestId, 'network-42');
  assert.equal(observed.rewrites[0][1].reason, 'already_locked');
});

test('incidental private nonofficial requests never replace the formal lock verdict', async () => {
  const events = [];
  class Monitor {
    configuration() { return { lockedModels: ['gpt-6'] }; }
    verificationTransaction() { return null; }
    async pausedPostData() { return ''; }
    async continuePaused(...args) { events.push(['continue', ...args]); }
    onRewrite(...args) { events.push(['rewrite', ...args]); }
    async handlePausedRequest() {}
  }
  vm.runInNewContext(source.slice(entry).replace('export function installPrivateRequestRoutingHook()', 'function installPrivateRequestRoutingHook()'), {
    ChatGptNetworkMonitor: Monitor,
    privateCoreChannel: {
      async isAvailable() { return true; },
      async windowKeyForTab() { return 'chrome:test'; },
      async request() { return { officialConversation: false, changed: false, reason: 'not_official_conversation' }; },
    },
    buildPrivateRequestPayload, safeRequestEndpoint,
    normalizePrivateRequestDecision(value) { return value; },
  });
  await new Monitor().handlePausedRequest(419, {
    requestId: 'fetch-incidental',
    request: { url: 'https://chatgpt.com/backend-api/conversations', method: 'GET' },
  });
  assert.equal(events.filter(([kind]) => kind === 'continue').length, 1);
  assert.equal(events.filter(([kind]) => kind === 'rewrite').length, 0);
});
