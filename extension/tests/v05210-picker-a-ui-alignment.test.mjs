// v0.5.222: UI selection belongs exclusively to explicit model discovery.
// Passive Chat model observation and ordinary send never click the picker.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const from = source.indexOf('  async function alignSelection(');
const to = source.indexOf('  function scheduleReport()', from);
assert.ok(from >= 0 && to > from);
const alignSource = source.slice(from, to);

function setup({ pageModel = 'gpt-6', running = false, generating = false } = {}) {
  const choices = [];
  const runtime = {
    autoVerificationRunning: running,
    cachedPolicy: { lockedModels: ['gpt-5.5'] },
    visibleGeneratingControl: () => generating,
    collectObservation: () => ({ model: pageModel }),
    chooseExact: async (_selectors, model) => { choices.push(model); return true; },
    MODEL_SELECTORS: ['owned-picker-a'],
    normalizeDisplayedModel: value => value,
    window: { setTimeout: () => 0 },
    report: () => {},
  };
  vm.createContext(runtime);
  return { align: vm.runInContext(alignSource + '\nalignSelection', runtime), choices };
}

test('ordinary Chat never changes its checked GPT-6 model, even with force requested', async () => {
  const { align, choices } = setup();
  assert.equal(await align(), false);
  assert.equal(await align({ force: true }), false);
  assert.deepEqual(choices, []);
});

test('explicit discovery with force can select a different official model row', async () => {
  const { align, choices } = setup({ running: true });
  assert.equal(await align(), false);
  assert.equal(await align({ force: true }), true);
  assert.deepEqual(choices, ['gpt-5.5']);
});

test('discovering never guesses from missing/ambiguous page model', async () => {
  const { align, choices } = setup({ running: true, pageModel: null });
  assert.equal(await align({ force: true }), false);
  assert.deepEqual(choices, []);
});

test('discovery never clicks while an assistant response is generating', async () => {
  const { align, choices } = setup({ running: true, generating: true });
  assert.equal(await align({ force: true }), false);
  assert.deepEqual(choices, []);
});

test('ordinary Chat reports but never schedules automatic page alignment', () => {
  assert.doesNotMatch(source, /function scheduleAlign\(/);
  assert.doesNotMatch(source, /scheduleAlign\(\)/);
  assert.match(source, /function scheduleReport\(\)/);
  assert.match(source, /GPTLOCK_PAGE_OBSERVATION/);
});
