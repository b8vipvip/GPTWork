// v0.5.223: regression for user repro: one ordinary GPT-6 Chat turn survives
// the home -> /c/:id transition without dropping the CDP stream or page report.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { isActiveNewChatRequestHandoff } from '../chat-context-handoff.js';

const [background, content] = await Promise.all([
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
  readFile(new URL('../content.js', import.meta.url), 'utf8'),
]);

function extract(source, begin, end) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && stop > start, 'missing boundary: ' + begin);
  return source.slice(start, stop);
}

const stateSource = extract(background, 'function contextKey(value) {', 'function accountAllowsState(');

function stateHarness() {
  const logs = [];
  const runtime = vm.createContext({
    URL, Date,
    tabStates: new Map(),
    coreConnection: { connected: true },
    isActiveNewChatRequestHandoff,
    verificationTransactionForTab() { return null; },
    logRuntime(_level, _component, event, details) { logs.push({ event, details }); },
  });
  vm.runInContext(stateSource + '\nglobalThis.getState = ensureTabState;', runtime);
  return { get: runtime.getState, logs };
}

test('ordinary GPT-6 request and response epoch survives exactly one home-to-conversation transition', () => {
  const { get, logs } = stateHarness();
  const original = get(77, 'https://chatgpt.com/');
  original.monitor = { attached: true };
  original.phase = 'waiting';
  original.pageObservation = { model: null, reasoning: 'high' };
  original.lastRequest = {
    requestId: 'network-15316.437',
    capturedAt: new Date().toISOString(),
    model: 'gpt-6-thinking',
    reasoning: 'high',
  };
  const conversation = get(77, 'https://chatgpt.com/c/6ad036d7-9184-83e8-a6be-9ec1e9656951');
  assert.equal(conversation, original, 'same request state must survive home-to-/c');
  assert.equal(conversation.lastRequest.requestId, 'network-15316.437');
  assert.equal(conversation.phase, 'waiting');
  assert.equal(conversation.monitor.attached, true);
  assert.equal(logs.at(-1).event, 'normal_chat_request_context_migrated');
  const repeat = get(77, 'https://chatgpt.com/c/6ad036d7-9184-83e8-a6be-9ec1e9656951');
  assert.equal(repeat, original);

  const newConversation = get(77, 'https://chatgpt.com/c/another');
  assert.notEqual(newConversation, original, 'unrelated conversation must not inherit an old request');
  assert.equal(newConversation.lastRequest, null);
  assert.equal(newConversation.pageObservation, null);
});

test('new-chat local placeholder preserves request epoch through the final conversation route', () => {
  const { get, logs } = stateHarness();
  const initial = get(88, 'https://chatgpt.com/');
  initial.lastRequest = {
    requestId: '15564.488',
    capturedAt: new Date().toISOString(),
    model: 'gpt-6-astra',
    requestEvidenceSource: 'fetch_continued',
  };
  const local = get(88, 'https://chatgpt.com/c/local-chatgpt');
  assert.equal(local, initial);
  const final = get(88, 'https://chatgpt.com/c/real-conversation');
  assert.equal(final, initial, 'placeholder handoff must not erase forwarded-model correlation');
  assert.equal(final.lastRequest.model, 'gpt-6-astra');
  assert.equal(logs.filter(entry => entry.event === 'normal_chat_request_context_migrated').length, 2);
  const unrelated = get(88, 'https://chatgpt.com/c/unrelated');
  assert.notEqual(unrelated, initial);
  assert.equal(unrelated.lastRequest, null);
});

test('home navigation with no recent formal request resets state, never fabricates evidence', () => {
  const { get } = stateHarness();
  const initial = get(44, 'https://chatgpt.com/');
  initial.pageObservation = { model: 'gpt-5.6-sol', reasoning: 'high' };
  const next = get(44, 'https://chatgpt.com/c/first');
  assert.notEqual(next, initial);
  assert.equal(next.lastRequest, null);
  assert.equal(next.pageObservation, null);

  const stale = get(55, 'https://chatgpt.com/');
  stale.lastRequest = { requestId: 'old', capturedAt: new Date(Date.now() - 3600_000).toISOString() };
  const after = get(55, 'https://chatgpt.com/c/stale');
  assert.notEqual(after, stale, 'expired request cannot leak to a new conversation');
});

const configSource = extract(background, 'async function configureTab(tab) {', 'async function configureOpenTabs()');

function configurationHarness({ attached, enabled = true } = {}) {
  const calls = [];
  const runtime = vm.createContext({
    isChatGptUrl(value) { return value?.startsWith('https://chatgpt.com/'); },
    ensureTabState(tabId, url) { return { tabId, url, windowId: null }; },
    masterRuntimeEnabled() { return true; },
    effectiveSettingsForState() { return { enabled }; },
    originArmedTabIds: new Set(),
    async configureOriginTrace() {},
    networkMonitor: {
      isAttached() { return attached; },
      async attach(tabId) { calls.push('attach:' + tabId); },
      async detach(tabId) { calls.push('detach:' + tabId); },
    },
    async broadcastTabState(tabId) { calls.push('broadcast:' + tabId); },
    chrome: { action: { async setBadgeText() {} } },
  });
  vm.runInContext(configSource + '\nglobalThis.configure = configureTab;', runtime);
  return { configure: runtime.configure, calls };
}

test('loading transition never detaches or loses an active request capture', async () => {
  const h = configurationHarness({ attached: true });
  await h.configure({ id: 77, windowId: 1, status: 'loading', url: 'https://chatgpt.com/c/new' });
  assert.ok(!h.calls.some(value => value.startsWith('detach:')));
  assert.ok(h.calls.includes('attach:77'));
});

test('loading unconnected tabs defer attach until complete; disabled tabs still detach', async () => {
  const h = configurationHarness({ attached: false });
  await h.configure({ id: 77, status: 'loading', url: 'https://chatgpt.com/' });
  assert.deepEqual(h.calls, ['broadcast:77']);
  await h.configure({ id: 77, status: 'complete', url: 'https://chatgpt.com/' });
  assert.ok(h.calls.includes('attach:77'));
  const disabled = configurationHarness({ attached: true, enabled: false });
  await disabled.configure({ id: 77, status: 'loading', url: 'https://chatgpt.com/' });
  assert.ok(disabled.calls.includes('detach:77'));
});

const reportSource = extract(content, '  async function report() {', '  function visible(element) {');

test('failed initial DOM observation remains eligible for retry without picker clicks', async () => {
  let sends = 0;
  let updates = 0;
  const runtime = vm.createContext({
    previousFingerprint: '',
    collectObservation() {
      return { model: null, reasoning: 'high', modelEvidenceSource: 'none', reasoningEvidenceSource: 'composer' };
    },
    sendMessage() {
      sends += 1;
      if (sends === 1) return Promise.reject(new Error('service worker reloading'));
      return Promise.resolve({ accepted: true });
    },
    updateCache() { updates += 1; },
  });
  vm.runInContext(reportSource + '\nglobalThis.reportPage = report;', runtime);
  await runtime.reportPage();
  assert.equal(runtime.previousFingerprint, '', 'failed report must not mark snapshot delivered');
  await runtime.reportPage();
  assert.equal(sends, 2);
  assert.equal(updates, 1);
  assert.notEqual(runtime.previousFingerprint, '');
  await runtime.reportPage();
  assert.equal(sends, 2, 'unchanged acknowledged observation deduplicates normally');
});
