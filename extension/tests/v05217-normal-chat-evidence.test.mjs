import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [feature, background, content, monitor, catalog, page, popup] = await Promise.all([
  read('tab-feature-runtime.js'), read('background.js'), read('content.js'),
  read('network-monitor.js'), read('model-catalog.js'),
  read('page-model-evidence.js'), read('popup.js'),
]);

function requestPolicy({ pageModel = null, enabled = true, locks = ['gpt-6'], stored = locks } = {}) {
  const start = feature.indexOf('export function requestPolicyForTabSync(');
  const end = feature.indexOf('\nexport function effectivePolicyForTabSync(', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    masterEnabled: true, workFeatureEnabled: false,
    modelLockSelection: locks, basePolicy: { lockedModels: stored, workDefaultModel: 'gpt-6-astra' },
    tabFeatureStateSync() { return { modelLockEnabled: enabled, workModeEnabled: false }; },
    normalizeState() { return { modelLockEnabled: false, workModeEnabled: false }; },
    normalizeConcreteModelId(value) { return typeof value === 'string' && /^gpt-/.test(value) ? value : null; },
    normalizeModels(value) { return Array.isArray(value) ? value.filter(Boolean) : []; },
    normalizePolicy(value) { return value; },
  });
  vm.runInContext(feature.slice(start, end).replace('export function', 'function')
    + '\nglobalThis.choose = requestPolicyForTabSync;', context);
  return Array.from(context.choose(42, pageModel).lockedModels);
}

test('normal Chat with High-only page retains explicitly configured GPT-6 lock', () => {
  assert.deepEqual(requestPolicy({ pageModel: null, locks: ['gpt-6'] }), ['gpt-6']);
  assert.deepEqual(requestPolicy({ pageModel: 'gpt-5.5', locks: ['gpt-6'] }), ['gpt-6']);
});

test('allowed official page model wins within configured allow-list; no lock toggle is respected', () => {
  assert.deepEqual(requestPolicy({ pageModel: 'gpt-5.6-sol', locks: ['gpt-6', 'gpt-5.6-sol'] }), ['gpt-5.6-sol']);
  assert.deepEqual(requestPolicy({ pageModel: null, locks: ['gpt-6', 'gpt-5.6-sol'] }), ['gpt-6']);
  assert.deepEqual(requestPolicy({ pageModel: 'gpt-6', locks: ['gpt-6'], enabled: false }), []);
  assert.deepEqual(requestPolicy({ pageModel: null, locks: [], stored: [] }), []);
});

test('composer input prearms Network before click and send_started fallback', () => {
  const prearm = content.indexOf("document.addEventListener('input'");
  const pointerdown = content.indexOf("document.addEventListener('pointerdown'");
  const click = content.indexOf("document.addEventListener('click'");
  assert.ok(prearm >= 0 && prearm < click && pointerdown >= 0 && pointerdown < click);
  assert.match(content, /GPTLOCK_ARM_NORMAL_CHAT_CAPTURE/);
  assert.match(content, /if \(matchesAny\(event\.target, COMPOSER_SELECTORS\)\) prearmNormalChatCapture\(\)/);
  assert.match(content, /cachedState\?\.autoVerification\?\.running === true\) return/);
  const arm = background.indexOf("case 'GPTLOCK_ARM_NORMAL_CHAT_CAPTURE':");
  const send = background.indexOf("case 'GPTLOCK_SEND_STARTED':");
  assert.ok(arm >= 0 && send > arm);
  assert.match(background.slice(arm, send), /enableResponseCapture\(sender\.tab\.id\)/);
  assert.match(background.slice(arm, send), /effectiveSettingsForState\(state\)\.enabled/);
  assert.match(monitor, /hasResponseCapture\(tabId\)\s*\{\s*return this\.responseCaptureTabs\.has\(tabId\)/);
});

function catalogSnapshot(state, policy = { lockedModels: ['gpt-6'] }) {
  const start = catalog.indexOf('  function modelSnapshot(state) {');
  const end = catalog.indexOf('\n  function rememberModels(candidates) {', start);
  assert.ok(start >= 0 && end > start);
  const runtime = vm.createContext({
    currentPolicy: policy, trustedStatus: null,
    normalizeModelId(value) { return typeof value === 'string' ? value : null; },
    normalizeConcreteModelId(value) { return typeof value === 'string' ? value : null; },
    timestamp(value) { return Number.isFinite(Date.parse(value || '')) ? Date.parse(value) : 0; },
    modelLabel(value) { return value; },
    effectivePageObservation(value) { return value?.pageObservation || null; },
    responseAppliesToLatestRequest() { return false; },
  });
  vm.runInContext(catalog.slice(start, end) + '\nglobalThis.snapshot = modelSnapshot;', runtime);
  return runtime.snapshot(state);
}

test('real intercepted POST is request model evidence even with nonempty lock', () => {
  const state = { lastRewrite: {
    fetchRequestId: 'fetch-job-123', endpoint: '/backend-api/f/conversation',
    modelBefore: 'gpt-5.5', modelAfter: 'gpt-6',
    capturedAt: '2026-10-11T03:49:10.000Z',
  }};
  assert.equal(catalogSnapshot(state).request.id, 'gpt-6');
  assert.equal(catalogSnapshot(state).request.historical, false);
  assert.equal(catalogSnapshot({ lastRewrite: { ...state.lastRewrite, fetchRequestId: null } }).request.id, null);
  assert.equal(catalogSnapshot({ lastRewrite: { ...state.lastRewrite, error: 'continue_failed' } }).request.id, null);
});

function lastResponse(tab) {
  const start = popup.indexOf('function observedOrdinaryChatResponse(tab) {');
  const end = popup.indexOf('\nfunction autoVerificationAppliesToLatestRequest(', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({});
  vm.runInContext(popup.slice(start, end) + '\nglobalThis.pick = observedOrdinaryChatResponse;', context);
  return context.pick(tab);
}

test('popup only shows attributable served response metadata as observation', () => {
  const tab = {
    phase: 'unverified',
    lastRequest: { requestId: 'r1', capturedAt: '2026-10-11T03:49:08.000Z' },
    lastResponseEvidence: {
      requestId: 'r1', capturedAt: '2026-10-11T03:49:12.000Z',
      evidenceSource: 'network_response_metadata',
      model: 'gpt-6-thinking', fields: { model: 'message.metadata.served_model' },
      conflicts: { model: false }, bodyError: null,
    },
  };
  assert.equal(lastResponse(tab)?.model, 'gpt-6-thinking');
  assert.equal(lastResponse({ ...tab, phase: 'waiting' }), null);
  assert.equal(lastResponse({ ...tab, lastResponseEvidence: { ...tab.lastResponseEvidence, requestId: 'r2' } }), null);
  assert.equal(lastResponse({ ...tab, lastResponseEvidence: { ...tab.lastResponseEvidence, fields: {} } }), null);
  assert.equal(lastResponse({ ...tab, lastResponseEvidence: { ...tab.lastResponseEvidence, conflicts: { model: true } } }), null);
  assert.equal(lastResponse({ ...tab, lastResponseEvidence: { ...tab.lastResponseEvidence, capturedAt: '2026-10-11T03:40:00.000Z' } }), null);
  assert.match(popup, /响应元数据已观测（未验证）/);
});

test('closed High-only menu retains only an actual, recent checked Picker A row', () => {
  let now = 300000;
  let pathname = '/c/current';
  let expanded = true;
  let rowVisible = true;
  function node(attrs = {}, text = '') {
    return {
      innerText: text, textContent: text,
      getAttribute(name) {
        if (name === 'aria-expanded' && attrs['aria-haspopup']) return expanded ? 'true' : 'false';
        return attrs[name] ?? null;
      },
      getBoundingClientRect() { return { width: rowVisible ? 120 : 0, height: rowVisible ? 30 : 0 }; },
      querySelectorAll() { return []; },
    };
  }
  const trigger = node({
    'aria-label': '选择 ChatGPT 模型', 'aria-haspopup': 'menu',
    'aria-controls': 'owned-picker',
  }, 'High');
  const rows = [
    node({ 'aria-checked': 'true' }, 'GPT-6'),
    node({ 'aria-checked': 'false' }, 'GPT-5.6 Sol'),
    node({ 'aria-checked': 'false' }, 'GPT-5.5\nLeaving on October 14'),
  ];
  const popupMenu = node();
  popupMenu.querySelectorAll = selector => selector.includes('menuitemradio') ? rows : [];
  const form = node();
  form.querySelector = selector => selector === '#prompt-textarea' ? node() : null;
  form.querySelectorAll = selector =>
    selector.includes('aria-haspopup') || selector.includes("button,[role='button']") ? [trigger] : [];
  const document = {
    querySelectorAll(selector) {
      return selector === "form[data-type='unified-composer']" || selector === 'form' ? [form] : [];
    },
    getElementById(id) { return id === 'owned-picker' ? popupMenu : null; },
  };
  const runtime = vm.createContext({
    document, location: { get pathname() { return pathname; } },
    Date: class extends Date { static now() { return now; } },
    getComputedStyle() { return { display: 'block', visibility: 'visible' }; },
  });
  vm.runInContext(page, runtime);
  const collect = runtime.__GPTLOCK_PAGE_MODEL_EVIDENCE__.collect;
  assert.equal(collect().modelSource, 'official-picker-a-checked');
  expanded = false;
  assert.equal(collect().modelSource, 'official-picker-a-last-checked');
  assert.equal(collect().model, 'gpt-6');
  assert.match(catalog, /上次菜单勾选/);
  pathname = '/c/other';
  assert.equal(collect().model, null, 'stale conversation must not reuse prior model');
  pathname = '/c/current';
  now += 120001;
  assert.equal(collect().model, null, 'old cached selection must expire');
});
