import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { extractRequestEvidence, rewriteConversationPostData } from '../network-evidence.js';

const catalog = await readFile(new URL('../model-catalog.js', import.meta.url), 'utf8');
const page = await readFile(new URL('../page-model-evidence.js', import.meta.url), 'utf8');

function modelSnapshot(state, policy = { lockedModels: [] }) {
  const start = catalog.indexOf('  function modelSnapshot(state) {');
  const end = catalog.indexOf('\n  function rememberModels(candidates) {', start);
  assert.ok(start > 0 && end > start, 'actual catalog snapshot implementation must be executable');
  const runtime = vm.createContext({
    currentPolicy: policy,
    trustedStatus: null,
    normalizeModelId(value) {
      const model = String(value ?? '').trim().toLowerCase();
      return /^[a-z0-9._:-]{1,128}$/.test(model) ? model : null;
    },
    normalizeConcreteModelId(value) {
      const model = String(value ?? '').trim().toLowerCase();
      return model !== 'auto' && /^[a-z0-9._:-]{1,128}$/.test(model) ? model : null;
    },
    timestamp(value) {
      const parsed = Date.parse(value || '');
      return Number.isFinite(parsed) ? parsed : 0;
    },
    modelLabel(value) { return value; },
    effectivePageObservation(value) { return value?.pageObservation ?? null; },
    responseAppliesToLatestRequest() { return false; },
  });
  vm.runInContext(catalog.slice(start, end) + '\n globalThis.snapshot = modelSnapshot;', runtime);
  return runtime.snapshot(state);
}

const t1 = '2026-10-11T02:26:00.000Z';
const t2 = '2026-10-11T02:27:00.000Z';

function observedResponse(overrides = {}) {
  return {
    requestId: 'r1',
    capturedAt: t2,
    evidenceSource: 'network_response_metadata',
    model: 'gpt-6-thinking',
    fields: { model: 'message.metadata.served_model' },
    conflicts: { model: false, reasoning: false },
    ...overrides,
  };
}

test('unlocked Chat never rewrites a genuine POST but exposes request model metadata', () => {
  const original = JSON.stringify({ model: 'gpt-6-thinking', messages: [{ content: { parts: ['hi'] } }] });
  const expected = extractRequestEvidence(original);
  const result = rewriteConversationPostData(original, { lockedModels: [] });
  assert.equal(result.reason, 'no_locked_model');
  assert.equal(result.changed, false);
  assert.equal(result.postData, original);
  assert.equal(result.modelBefore, expected.model);
  assert.equal(result.modelAfter, expected.model);
  assert.equal(result.transportModelBefore, expected.rawModel);
  assert.equal(result.transportModelAfter, expected.rawModel);
});

test('no-lock request with absent model remains unknown, never inferred from page model', () => {
  const result = rewriteConversationPostData(JSON.stringify({ messages: [] }), { lockedModels: [] });
  assert.equal(result.reason, 'no_locked_model');
  assert.equal(result.modelAfter, null);
  assert.equal(result.changed, false);
});

test('formal no-lock Fetch model is a request observation even when Network event is missing', () => {
  const valid = modelSnapshot({
    lastRewrite: {
      fetchRequestId: 'interception-job-1', endpoint: '/backend-api/f/conversation',
      capturedAt: t1, modelAfter: 'gpt-6-thinking',
    },
  });
  assert.equal(valid.request.id, null);
  assert.equal(valid.request.label, '未锁定');
  assert.equal(valid.request.historical, false);
  assert.equal(modelSnapshot({ lastRewrite: {
    fetchRequestId: null, endpoint: '/backend-api/f/conversation', modelAfter: 'gpt-6-thinking',
  } }).request.id, null);
  assert.equal(modelSnapshot({ lastRewrite: {
    fetchRequestId: 'interception-job-1', endpoint: '/backend-api/f/other', modelAfter: 'gpt-6-thinking',
  } }).request.id, null);
});

test('no-lock direct served-model response is visible as observation without a strict verified verdict', () => {
  const state = {
    phase: 'unverified',
    lastRequest: { requestId: 'r1', capturedAt: t1, model: 'gpt-6-thinking' },
    lastVerification: null,
    lastResponseEvidence: observedResponse(),
  };
  const snapshot = modelSnapshot(state);
  assert.equal(snapshot.request.id, null);
  assert.equal(snapshot.request.label, '未锁定');
  assert.equal(snapshot.response.id, 'gpt-6-thinking');
  assert.equal(snapshot.response.status, 'response');
  assert.equal(snapshot.response.confirmed, false);
  assert.equal(snapshot.response.mismatch, false);
  assert.match(snapshot.response.label, /实际响应/);
});

test('no-lock response fails closed on stale, conflicting, missing-authority or in-flight data', () => {
  const base = {
    phase: 'unverified',
    lastRequest: { requestId: 'r1', capturedAt: t1, model: null },
    lastResponseEvidence: observedResponse(),
  };
  for (const patch of [
    { lastRequest: { requestId: 'r2', capturedAt: t1 } },
    { lastResponseEvidence: observedResponse({ conflicts: { model: true } }) },
    { lastResponseEvidence: observedResponse({ fields: { model: null } }) },
    { lastResponseEvidence: observedResponse({ evidenceSource: 'page_dom_live' }) },
    { lastResponseEvidence: observedResponse({ capturedAt: '2026-10-10T00:00:00.000Z' }) },
    { phase: 'waiting' },
  ]) {
    const snapshot = modelSnapshot({ ...base, ...patch });
    assert.equal(snapshot.response.id, null, JSON.stringify(patch));
    assert.equal(snapshot.response.confirmed, false, JSON.stringify(patch));
  }
});

test('a checked Picker A row is scoped to the composer-owned aria-controls menu', () => {
  assert.match(page, /const scopes = controlled && visible\(controlled\) \? \[controlled\] : \[\]/);
  assert.doesNotMatch(page, /\.\.\.document\.querySelectorAll\("\[role='menu'\]/);
});

test('a pending normal Chat turn hides prior request and response history until new evidence arrives', async () => {
  await import('../model-status-history.js');
  const history = globalThis.__GPTLOCK_MODEL_STATUS_HISTORY__;
  const prior = {
    schemaVersion: 1,
    request: { model: 'gpt-5.5', capturedAt: t1 },
    response: { model: 'gpt-5.5', capturedAt: t2, confirmed: true },
  };
  const pending = history.selectStatus({
    state: { phase: 'waiting', lastRequest: null, lastVerification: null },
    history: prior,
    policy: { lockedModels: [] },
    nowMs: Date.parse(t2) + 5000,
  });
  assert.equal(pending.request.id, null);
  assert.equal(pending.response.id, null);
  const idle = history.selectStatus({
    state: { phase: 'unverified', lastRequest: null, lastVerification: null },
    history: prior,
    policy: { lockedModels: [] },
    nowMs: Date.parse(t2) + 5000,
  });
  assert.equal(idle.request.id, 'gpt-5.5');
  assert.equal(idle.response.id, 'gpt-5.5');
});

test('real Picker A GPT-5.5 row with retirement subtitle is read as the checked model', () => {
  function node(attrs = {}, text = '') {
    return {
      innerText: text, textContent: text,
      getAttribute(name) { return attrs[name] ?? null; },
      getBoundingClientRect() { return { width: 120, height: 30 }; },
      querySelectorAll() { return []; },
    };
  }
  const trigger = node({
    'aria-label': '选择模型', 'aria-haspopup': 'menu',
    'aria-expanded': 'true', 'aria-controls': 'owned-picker',
  }, 'High');
  const rows = [
    node({ 'aria-checked': 'false' }, 'GPT-6'),
    node({ 'aria-checked': 'false' }, 'GPT-5.6 Sol'),
    node({ 'data-state': 'checked' }, 'GPT-5.5\nLeaving on October 14'),
  ];
  const popup = node();
  popup.querySelectorAll = selector => selector.includes("menuitemradio") ? rows : [];
  const form = node();
  form.querySelector = selector => selector === '#prompt-textarea' ? node() : null;
  form.querySelectorAll = selector =>
    selector.includes("aria-haspopup") || selector.includes("button,[role='button']")
      ? [trigger] : [];
  const document = {
    querySelectorAll(selector) {
      if (selector === "form[data-type='unified-composer']" || selector === 'form') return [form];
      return [];
    },
    getElementById(id) { return id === 'owned-picker' ? popup : null; },
  };
  const runtime = vm.createContext({
    document, getComputedStyle() { return { display: 'block', visibility: 'visible' }; },
  });
  vm.runInContext(page, runtime);
  const observed = runtime.__GPTLOCK_PAGE_MODEL_EVIDENCE__.collect();
  assert.equal(observed.model, 'gpt-5.5');
  assert.equal(observed.modelSource, 'official-picker-a-checked');
});
