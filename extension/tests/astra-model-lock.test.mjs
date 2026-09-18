import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import {
  DEFAULT_POLICY,
  KNOWN_MODELS,
  normalizeModelId,
  prioritizeModels,
} from '../policy.js';
import {
  extractRequestEvidence,
  rewriteConversationPostData,
} from '../network-evidence.js';

const baseEvidenceSource = await readFile(new URL('../page-model-evidence.js', import.meta.url), 'utf8');
const astraEvidenceSource = await readFile(new URL('../astra-model-evidence.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const migrationSource = await readFile(new URL('../settings-migration.js', import.meta.url), 'utf8');

function loadPageEvidenceAdapter() {
  const context = vm.createContext({});
  vm.runInContext(baseEvidenceSource, context);
  vm.runInContext(astraEvidenceSource, context);
  return context.__GPTLOCK_PAGE_MODEL_EVIDENCE__;
}

test('Astra is the default preferred model while Sol remains an allowed fallback', () => {
  assert.deepEqual(DEFAULT_POLICY.lockedModels, ['gpt-6-astra', 'gpt-5.6-sol']);
  assert.equal(KNOWN_MODELS[0].id, 'gpt-6-astra');
  assert.equal(KNOWN_MODELS[0].label, 'GPT-6 Astra');
});

test('canonicalizes Astra-family transport slugs without inventing one transport suffix', () => {
  for (const model of ['gpt-6-astra', 'gpt-6-astra-wm', 'gpt-6-astra.preview', 'gpt-6-astra:work']) {
    assert.equal(normalizeModelId(model), 'gpt-6-astra');
  }
  assert.equal(extractRequestEvidence('{"model":"gpt-6-astra-wm"}').model, 'gpt-6-astra');
});

test('preserves the real Astra transport slug when ChatGPT already selected Astra', () => {
  const source = JSON.stringify({ model: 'gpt-6-astra-wm', reasoning_effort: 'high' });
  const result = rewriteConversationPostData(source, {
    lockedModels: ['gpt-6-astra', 'gpt-5.6-sol'],
    allowedReasoningLevels: ['high'],
    preferredReasoning: 'high',
  });
  assert.equal(result.changed, false);
  assert.equal(result.modelBefore, 'gpt-6-astra');
  assert.equal(result.modelAfter, 'gpt-6-astra');
  assert.equal(result.transportModelBefore, 'gpt-6-astra-wm');
  assert.equal(result.transportModelAfter, 'gpt-6-astra-wm');
});

test('multi-model selection always requests Astra before Sol', () => {
  const source = JSON.stringify({ model: 'gpt-5.6-sol-wm', reasoning_effort: 'high' });
  const result = rewriteConversationPostData(source, {
    lockedModels: ['gpt-5.6-sol', 'gpt-6-astra'],
    allowedReasoningLevels: ['high'],
    preferredReasoning: 'high',
  });
  assert.equal(result.changed, true);
  assert.equal(result.modelBefore, 'gpt-5.6-sol');
  assert.equal(result.modelAfter, 'gpt-6-astra');
  assert.equal(result.transportModelAfter, 'gpt-6-astra-wm');
  assert.deepEqual(prioritizeModels(['gpt-5.6-sol', 'gpt-6-astra']), ['gpt-6-astra', 'gpt-5.6-sol']);
  assert.deepEqual(prioritizeModels(['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1']), ['gpt-6.1', 'gpt-6-astra', 'gpt-5.6-sol']);
});

test('rewrites a disallowed concrete model to Astra as the preferred policy target', () => {
  const result = rewriteConversationPostData(JSON.stringify({ model: 'gpt-5.5' }), {
    lockedModels: ['gpt-6-astra', 'gpt-5.6-sol'],
    allowedReasoningLevels: ['high'],
    preferredReasoning: 'high',
  });
  assert.equal(result.changed, true);
  assert.equal(result.modelAfter, 'gpt-6-astra');
  assert.equal(result.transportModelAfter, 'gpt-6-astra-wm');
});

test('Astra page adapter recognizes visible Astra labels and likely transport labels', () => {
  const adapter = loadPageEvidenceAdapter();
  assert.equal(adapter.modelFromText('GPT-6 Astra 高'), 'gpt-6-astra');
  assert.equal(adapter.modelFromText('6 Astra'), 'gpt-6-astra');
  assert.equal(adapter.modelFromText('gpt-6-astra-wm'), 'gpt-6-astra');
  assert.equal(adapter.modelFromText('GPT-5.6 Sol 高'), 'gpt-5.6-sol');
});

test('Astra evidence patch loads immediately after the base page evidence adapter', () => {
  const scripts = manifest.content_scripts[0].js;
  const baseIndex = scripts.indexOf('page-model-evidence.js');
  const astraIndex = scripts.indexOf('astra-model-evidence.js');
  const contentIndex = scripts.indexOf('content.js');
  assert.equal(astraIndex, baseIndex + 1);
  assert.ok(astraIndex < contentIndex);
});

test('existing Sol policies receive the one-shot Astra preference migration', () => {
  assert.match(migrationSource, /astraPolicyMigrationV1/);
  assert.match(migrationSource, /lockedModels = \[ASTRA_MODEL_ID, \.\.\.lockedModels\]/);
  assert.match(migrationSource, /patch\[ASTRA_POLICY_MIGRATION_KEY\] = true/);
  assert.match(migrationSource, /later manual Astra opt-out is respected/);
});
