import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const adapterSource = await readFile(new URL('../page-model-evidence.js', import.meta.url), 'utf8');
const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const catalogSource = await readFile(new URL('../model-catalog.js', import.meta.url), 'utf8');

function loadAdapter() {
  const context = vm.createContext({});
  vm.runInContext(adapterSource, context);
  return context.__GPTLOCK_PAGE_MODEL_EVIDENCE__;
}

test('normalizes the model-family labels already validated by chat2api', () => {
  const adapter = loadAdapter();
  assert.equal(adapter.modelFromText('GPT-5.6 Sol 高'), 'gpt-5.6-sol');
  assert.equal(adapter.modelFromText('5.6 Sol'), 'gpt-5.6-sol');
  assert.equal(adapter.modelFromText('gpt-5.6-sol-wm'), 'gpt-5.6-sol');
  assert.equal(adapter.modelFromText('GPT-5.5'), 'gpt-5.5');
  assert.equal(adapter.modelFromText('5.5 高'), 'gpt-5.5');
  assert.equal(adapter.modelFromText('15.5 高'), null);
});

test('uses the chat2api composer and selected-state page objects as model evidence', () => {
  assert.match(adapterSource, /form\[data-type='unified-composer'\]/);
  assert.match(adapterSource, /\[aria-checked='true'\]/);
  assert.match(adapterSource, /\[aria-selected='true'\]/);
  assert.match(adapterSource, /\[data-state='checked'\]/);
  assert.match(adapterSource, /\[data-state='selected'\]/);
  assert.match(adapterSource, /\[data-selected='true'\]/);
  assert.match(adapterSource, /button\[class\*='composer-pill'\]/);
  assert.match(adapterSource, /button\[data-testid\*='model' i\]/);
  assert.match(adapterSource, /data-model-id/);
  assert.match(adapterSource, /function evidenceValues/);
  assert.match(adapterSource, /element\.innerText/);
  assert.match(adapterSource, /element\.textContent/);
  assert.match(adapterSource, /generic aria-label/);
  assert.match(adapterSource, /effectiveModels\.length === 1/);
  assert.match(adapterSource, /ambiguous-dom/);
});

test('both page observation paths prefer validated composer evidence', () => {
  assert.match(contentSource, /__GPTLOCK_PAGE_MODEL_EVIDENCE__\?\.collect/);
  assert.match(contentSource, /modelEvidenceSource: validated\.modelSource/);
  assert.match(catalogSource, /__GPTLOCK_PAGE_MODEL_EVIDENCE__\?\.collect/);
  assert.match(catalogSource, /modelEvidenceSource: validated\?\.modelSource/);
});

test('selection attribute changes refresh page evidence', () => {
  for (const name of ['aria-checked', 'aria-selected', 'data-state', 'data-selected', 'data-value', 'data-model', 'data-model-id']) {
    assert.ok(contentSource.includes(`'${name}'`), `content observer should watch ${name}`);
    assert.ok(catalogSource.includes(`'${name}'`), `catalog observer should watch ${name}`);
  }
});


test('policy canonicalizes GPT-6 Astra and Sol transport aliases', async () => {
  const policy = await import('../policy.js');
  assert.equal(policy.normalizeModelId('gpt-6-astra-wm'), 'gpt-6-astra');
  assert.equal(policy.normalizeModelId('gpt-6-sol-wm'), 'gpt-6-sol');
  assert.equal(policy.modelTransportId('gpt-6-astra'), 'gpt-6-astra-wm');
  assert.equal(policy.modelTransportId('gpt-6-sol'), 'gpt-6-sol-wm');
});
