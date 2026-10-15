import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [evidence, content] = await Promise.all([
  readFile(new URL('../page-model-evidence.js', import.meta.url), 'utf8'),
  readFile(new URL('../content.js', import.meta.url), 'utf8'),
]);

test('checked GPT-6 on home composer follows only its first newly created conversation', () => {
  let pathname = '/';
  let expanded = true;
  let rowVisible = true;
  function element(attrs = {}, label = '') {
    return {
      innerText: label, textContent: label,
      getAttribute(name) {
        if (name === 'aria-expanded' && attrs['aria-haspopup']) return expanded ? 'true' : 'false';
        return attrs[name] ?? null;
      },
      getBoundingClientRect() { return { width: rowVisible ? 120 : 0, height: rowVisible ? 30 : 0 }; },
      querySelectorAll() { return []; },
    };
  }
  const picker = element();
  picker.querySelectorAll = selector => selector.includes('menuitemradio') ? [
    element({ 'aria-checked': 'true' }, 'GPT-6'),
    element({ 'aria-checked': 'false' }, 'GPT-5.6 Sol'),
  ] : [];
  const trigger = element({
    'aria-label': '选择 ChatGPT 模型', 'aria-haspopup': 'menu', 'aria-controls': 'owned-menu',
  }, 'High');
  const form = element();
  form.querySelector = selector => selector === '#prompt-textarea' ? element() : null;
  form.querySelectorAll = selector =>
    selector.includes('aria-haspopup') || selector.includes("button,[role='button']") ? [trigger] : [];
  const document = {
    querySelectorAll(selector) {
      return selector === "form[data-type='unified-composer']" || selector === 'form' ? [form] : [];
    },
    getElementById(id) { return id === 'owned-menu' ? picker : null; },
  };
  const runtime = vm.createContext({
    document, location: { get pathname() { return pathname; } },
    getComputedStyle() { return { display: 'block', visibility: 'visible' }; },
  });
  vm.runInContext(evidence, runtime);
  const observe = runtime.__GPTLOCK_PAGE_MODEL_EVIDENCE__;
  assert.equal(observe.collect().model, 'gpt-6');
  assert.equal(observe.collect().modelSource, 'official-picker-a-checked');

  expanded = false;
  pathname = '/c/6ad036d7-9184-83e8-a6be-9ec1e9656951';
  const first = observe.collect();
  assert.equal(first.model, 'gpt-6');
  assert.equal(first.modelSource, 'official-picker-a-last-checked');
  assert.equal(first.reasoning, 'high');

  pathname = '/c/second';
  assert.equal(observe.collect().model, null, 'different conversation cannot claim earlier row');

  pathname = '/';
  assert.equal(observe.collect().model, null, 'returning home cannot resurrect a previous conversation');
});

test('High-only page with no observed checked Picker A row remains unknown, never guessed as GPT-6', () => {
  const runtime = vm.createContext({
    document: { querySelectorAll() { return []; } },
    location: { pathname: '/c/unknown' },
    getComputedStyle() { return { display: 'block', visibility: 'visible' }; },
  });
  vm.runInContext(evidence, runtime);
  assert.equal(runtime.__GPTLOCK_PAGE_MODEL_EVIDENCE__.collect().model, null);
});

test('human picker selection is sampled before the 900ms UI report debounce, without automation', () => {
  assert.match(content, /if \(relevant\) \{\s*\/\/ Picker A is a short-lived Radix menu/);
  assert.match(content, /__GPTLOCK_PAGE_MODEL_EVIDENCE__\?\.selectedOfficialPickerAEvidence\?\.\(\)/);
  assert.match(content, /'aria-expanded',/);
  assert.doesNotMatch(content, /scheduleAlign\(\)/);
});
