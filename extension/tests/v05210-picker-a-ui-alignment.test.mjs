// Regression: a known Picker A page selection must not suppress auto-alignment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const from = source.indexOf('  async function alignSelection(');
const to = source.indexOf('  function scheduleAlign()', from);
assert.ok(from >= 0 && to > from);
const alignSource = source.slice(from, to);

function setup({ pageModel = 'gpt-6', running = false, autoAlignSelection = true } = {}) {
  const choices = [];
  const runtime = {
    cachedState: { autoVerification: { running }, knownModels: ['gpt-5.5', 'gpt-6'] },
    cachedSettings: { enabled: true, autoAlignSelection, preferredReasoning: 'high' },
    cachedPolicy: { lockedModels: ['gpt-5.5'], allowedReasoningLevels: ['high'] },
    visibleGeneratingControl: () => false,
    collectObservation: () => ({ model: pageModel, reasoning: 'high' }),
    chooseExact: async (_selectors, model) => { choices.push(model); return true; },
    MODEL_SELECTORS: ['owned-picker-a'],
    REASONING_SELECTORS: ['owned-reasoning'],
    normalizeDisplayedModel: value => value,
    normalizeDisplayedReasoning: value => value,
    location: { pathname: '/c/known-model' },
    lastAlignAttempt: '',
    lastAlignAt: 0,
    window: { setTimeout: () => 0 },
    report: () => {},
  };
  vm.createContext(runtime);
  return { align: vm.runInContext(alignSource + '\nalignSelection', runtime), choices };
}

test('normal Chat aligns GPT-6 to a locked GPT-5.5 even when GPT-6 is already a known model', async () => {
  const { align, choices } = setup();
  assert.equal(await align(), true);
  assert.deepEqual(choices, ['gpt-5.5']);
});

test('unknown page model is not used as a basis for forced UI model clicks', async () => {
  const { align, choices } = setup({ pageModel: null });
  assert.equal(await align(), false);
  assert.deepEqual(choices, []);
});

test('explicit discovery owns Picker A UI while running', async () => {
  const { align, choices } = setup({ running: true });
  assert.equal(await align(), false);
  assert.deepEqual(choices, []);
});

test('disabled auto-alignment never clicks Picker A', async () => {
  const { align, choices } = setup({ autoAlignSelection: false });
  assert.equal(await align(), false);
  assert.deepEqual(choices, []);
});
