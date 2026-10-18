import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [base, astra, catalog, content, background] = await Promise.all(
  ['page-model-evidence.js', 'astra-model-evidence.js', 'model-catalog.js', 'content.js', 'background.js']
    .map((name) => readFile(new URL('../' + name, import.meta.url), 'utf8')),
);

function fixture({ display = 'GPT-6 Astra', expanded = true, checked = null, extraButton = false } = {}) {
  function node(text = '', attrs = {}) {
    return {
      innerText: text, textContent: text,
      getAttribute(name) { return attrs[name] ?? null; },
      getBoundingClientRect() { return { width: 180, height: 30 }; },
      querySelectorAll() { return []; },
    };
  }
  const trigger = node(display, {
    'aria-label': '选择模型', 'aria-haspopup': 'menu',
    'aria-expanded': expanded ? 'true' : 'false', 'aria-controls': 'picker-a',
  });
  const rows = ['GPT-6', 'GPT-5.6 Sol'].map((label) => node(label, {
    'aria-checked': label === checked ? 'true' : 'false',
  }));
  const menu = node();
  menu.querySelectorAll = (selector) => selector.includes('menuitemradio') ? rows : [];
  const unrelated = node('GPT-6 Astra');
  const form = node();
  form.querySelector = (selector) => selector === '#prompt-textarea' ? node() : null;
  form.querySelectorAll = (selector) => {
    if (selector.includes('aria-haspopup')) return [trigger];
    if (selector.includes('composer-pill') || selector.includes("data-state='checked'")) return [];
    if (selector.includes('button,[role=')) return [trigger, ...(extraButton ? [unrelated] : [])];
    return [];
  };
  const document = {
    querySelectorAll(selector) {
      return selector === "form[data-type='unified-composer']" || selector === 'form' ? [form] : [];
    },
    getElementById(id) { return id === 'picker-a' ? menu : null; },
  };
  const runtime = vm.createContext({
    document, location: { pathname: '/c/active' },
    getComputedStyle() { return { display: 'block', visibility: 'visible' }; },
  });
  vm.runInContext(base, runtime);
  vm.runInContext(astra, runtime);
  return runtime.__GPTLOCK_PAGE_MODEL_EVIDENCE__.collect();
}

test('official current Astra display remains display evidence when Picker A only offers GPT-6 and Sol', () => {
  const result = fixture();
  assert.equal(result.model, 'gpt-6-astra');
  assert.equal(result.modelSource, 'composer-current-display');
  assert.equal(result.pickerA.observed, true);
  assert.deepEqual([...result.pickerA.models], ['gpt-6', 'gpt-5.6-sol']);
  assert.equal(result.pickerA.selectedModel, null);
});

test('official menu checked GPT-6 is separate from current Astra display', () => {
  const result = fixture({ checked: 'GPT-6' });
  assert.equal(result.model, 'gpt-6-astra');
  assert.equal(result.pickerA.selectedModel, 'gpt-6');
});

test('closed menu is unobserved, not proof Astra is unavailable', () => {
  const result = fixture({ expanded: false });
  assert.equal(result.model, 'gpt-6-astra');
  assert.equal(result.pickerA.observed, false);
  assert.deepEqual([...result.pickerA.models], []);
});

test('unselected arbitrary Astra text cannot override checked GPT-6', () => {
  const result = fixture({ display: 'High', checked: 'GPT-6', extraButton: true });
  assert.equal(result.model, 'gpt-6');
  assert.equal(result.modelSource, 'official-picker-a-checked');
});

test('floating evidence keeps display, menu, formal request and response separate', () => {
  const start = catalog.indexOf('  function modelSnapshot(state) {');
  const end = catalog.indexOf('\n  function rememberModels(candidates) {', start);
  assert.ok(start >= 0 && end > start);
  const runtime = vm.createContext({
    currentPolicy: { lockedModels: ['gpt-6-astra'] },
    trustedStatus: null,
    normalizeModelId(value) { return value || null; },
    normalizeConcreteModelId(value) { return value || null; },
    modelLabel(value) { return value; },
    effectivePageObservation(state) { return state?.pageObservation || null; },
    timestamp(value) { return Date.parse(value || '') || 0; },
    responseAppliesToLatestRequest() { return false; },
  });
  vm.runInContext(catalog.slice(start, end) + '\nglobalThis.snapshot = modelSnapshot;', runtime);
  const snapshot = runtime.snapshot({
    pageObservation: {
      model: 'gpt-6-astra', modelEvidenceSource: 'composer-current-display',
      pickerA: { observed: true, models: ['gpt-6', 'gpt-5.6-sol'], selectedModel: null },
    },
    phase: 'waiting',
  });
  assert.match(snapshot.page.label, /当前控件显示/);
  assert.match(snapshot.page.label, /菜单未列出/);
  assert.equal(snapshot.picker.observed, true);
  assert.deepEqual([...snapshot.picker.models], ['gpt-6', 'gpt-5.6-sol']);
  assert.equal(snapshot.request.id, null);
  assert.equal(snapshot.response.id, null);
  assert.match(catalog, /data-source="picker"/);
});

test('page observation and background preserve Picker A provenance and log only a menu snapshot', () => {
  assert.match(content, /pickerA: validated\.pickerA \|\| null/);
  assert.match(content, /observation\.pickerA/);
  assert.match(background, /pickerA: normalizePickerAObservation\(observation\.pickerA\)/);
  assert.match(background, /official_picker_a_catalog_observed/);
});
