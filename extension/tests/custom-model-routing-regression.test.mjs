import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  normalizeConcreteModelId,
  normalizeModelId,
  normalizePolicy,
} from '../policy.js';

const optionsHtml = fs.readFileSync(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const optionsJs = fs.readFileSync(new URL('../options.js', import.meta.url), 'utf8');
const catalog = fs.readFileSync(new URL('../model-catalog.js', import.meta.url), 'utf8');
const catalogOptions = fs.readFileSync(new URL('../model-catalog-options.js', import.meta.url), 'utf8');
const autoLock = fs.readFileSync(new URL('../model-auto-lock.js', import.meta.url), 'utf8');
const settingsMigration = fs.readFileSync(new URL('../settings-migration.js', import.meta.url), 'utf8');

test('auto remains observable as request metadata but is never a concrete lock target', () => {
  assert.equal(normalizeModelId('auto'), 'auto');
  assert.equal(normalizeConcreteModelId('auto'), null);
  assert.equal(normalizeConcreteModelId('gpt-5.6-luna'), 'gpt-5.6-luna');

  const policy = normalizePolicy({
    lockedModels: ['auto', 'gpt-5.6-luna'],
    allowedReasoningLevels: ['high'],
    strictMode: true,
  });
  assert.deepEqual(policy.lockedModels, ['gpt-5.6-luna']);

  const fallback = normalizePolicy({
    lockedModels: ['auto'],
    allowedReasoningLevels: ['high'],
    strictMode: true,
  });
  assert.deepEqual(fallback.lockedModels, ['gpt-5.6-sol']);
});

test('settings no longer expose manual custom-model entry', () => {
  assert.doesNotMatch(optionsHtml, /id="saveCustomModels"|id="customModels"/);
  assert.doesNotMatch(optionsJs, /addCustomModels|parseCustomModels|validateCustomModels/);
  assert.match(optionsHtml, /id="lockEditorToggle"/);
  assert.match(optionsHtml, /id="lockedModelSummary"/);
  assert.match(optionsHtml, /id="reasoningSummary"/);
});

test('model discovery schema v3 removes routing aliases before persistence', () => {
  assert.match(catalog, /DISCOVERY_SCHEMA_VERSION = 3/);
  assert.match(catalog, /NON_CONCRETE_MODEL_IDS = new Set\(\['auto'\]\)/);
  assert.match(catalog, /const model = normalizeConcreteModelId\(value\)/);
  assert.match(catalog, /const legacy = [^;]*\.map\(normalizeConcreteModelId\)\.filter\(Boolean\)/);

  assert.match(catalogOptions, /DISCOVERY_SCHEMA_VERSION = 3/);
  assert.match(catalogOptions, /NON_CONCRETE_MODEL_IDS = new Set\(\['auto'\]\)/);
  assert.match(catalogOptions, /\.map\(normalizeConcreteModelId\)/);
});

test('legacy model-auto-lock content shim stays inert under window-scoped background authority', () => {
  assert.match(autoLock, /compatibility file/i);
  assert.match(autoLock, /window-scoped|window/i);
  assert.doesNotMatch(autoLock, /chrome\.storage\.(?:sync|local)\.(?:set|remove)/);
  assert.doesNotMatch(autoLock, /lockedModels\s*=/);
});

test('extension startup purges historical auto discovery and lock state without opening Settings', () => {
  assert.match(settingsMigration, /export async function purgeNonConcreteModelState\(\)/);
  assert.match(settingsMigration, /DISCOVERED_MODELS_KEY = 'discoveredModels'/);
  assert.match(settingsMigration, /DISCOVERED_MODEL_EVIDENCE_KEY = 'discoveredModelEvidence'/);
  assert.match(settingsMigration, /POLICY_KEY = 'policy'/);
  assert.match(settingsMigration, /NON_CONCRETE_MODEL_IDS = new Set\(\['auto'\]\)/);
  assert.match(settingsMigration, /patch\[POLICY_KEY\] = \{ \.\.\.policy, lockedModels \}/);
  assert.match(settingsMigration, /void purgeNonConcreteModelState\(\)\.catch/);
});
