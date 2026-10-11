// Live screenshot regression: an official Chat GPT-6 radio is checked while the
// composer shows only "High". The page model must be GPT-6, never inferred Sol.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const script = await readFile(new URL('../page-model-evidence.js', import.meta.url), 'utf8');

function mount({ chosen = 'GPT-6', expanded = true, workExtra = false, multipleChecked = false } = {}) {
  const make = (text, attrs = {}) => ({
    innerText: text,
    textContent: text,
    getAttribute: name => attrs[name] ?? null,
    getBoundingClientRect: () => ({ width: 240, height: 30 }),
    querySelectorAll: () => [],
  });
  const trigger = make('High', {
    'aria-label': '选择模型',
    'aria-expanded': expanded ? 'true' : 'false',
    'aria-controls': 'owned-picker-menu',
  });
  const rows = ['GPT-6', 'GPT-5.6 Sol', 'GPT-5.5', ...(workExtra ? ['GPT-6 Astra'] : [])]
    .map(label => make(label, {
      'role': 'menuitemradio',
      'data-state': label === chosen || (multipleChecked && label === 'GPT-5.6 Sol')
        ? 'checked' : 'unchecked',
    }));
  const menu = make(rows.map(row => row.innerText).join(' '), { role: 'menu' });
  menu.querySelectorAll = selector =>
    selector.includes("menuitemradio") ? rows : [];

  const form = make('', {});
  form.querySelector = () => ({});
  form.querySelectorAll = selector => {
    if (selector.includes('aria-haspopup')) return [trigger];
    if (selector.includes("[aria-label]") && selector.includes('[data-model]')) return [trigger];
    return [];
  };
  const document = {
    querySelectorAll: selector => {
      if (selector === 'form') return [form];
      if (selector.includes("[role='menu']")) return [menu];
      return [];
    },
    getElementById: id => id === 'owned-picker-menu' ? menu : null,
  };
  const runtime = vm.createContext({
    document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  vm.runInContext(script, runtime);
  return runtime.__GPTLOCK_PAGE_MODEL_EVIDENCE__;
}

test('checked official GPT-6 picker row wins over generic High reasoning pill', () => {
  const observed = mount().collect();
  assert.equal(observed.model, 'gpt-6');
  assert.equal(observed.modelSource, 'official-picker-a-checked');
  assert.equal(observed.reasoning, 'high');
  assert.deepEqual(Array.from(observed.candidates).sort(), ['gpt-5.5', 'gpt-5.6-sol', 'gpt-6']);
});

test('official checked GPT-5.6 Sol and GPT-5.5 rows are also read exactly', () => {
  for (const [label, expected] of [
    ['GPT-5.6 Sol', 'gpt-5.6-sol'],
    ['GPT-5.5', 'gpt-5.5'],
  ]) {
    const observed = mount({ chosen: label }).collect();
    assert.equal(observed.model, expected);
    assert.equal(observed.modelSource, 'official-picker-a-checked');
  }
});

test('closed High-only composer pill leaves model unknown, not a fictional Sol confirmation', () => {
  const observed = mount({ expanded: false }).collect();
  assert.equal(observed.model, null);
  assert.equal(observed.reasoning, 'high');
  assert.equal(observed.modelSource, 'none');
});

test('conflicting checked rows and Work-model menus cannot masquerade as Picker A', () => {
  assert.equal(mount({ multipleChecked: true }).collect().model, null);
  assert.equal(mount({ workExtra: true }).collect().model, null);
});

test('no checked radio never derives a model from the list of available choices', () => {
  assert.equal(mount({ chosen: 'not-in-menu' }).collect().model, null);
});
