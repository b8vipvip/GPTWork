import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const adapterSource = await readFile(new URL('../page-model-evidence.js', import.meta.url), 'utf8');
const catalogSource = await readFile(new URL('../model-catalog.js', import.meta.url), 'utf8');
const optionsSource = await readFile(new URL('../model-catalog-options.js', import.meta.url), 'utf8');

function loadAdapter() {
  const context = vm.createContext({});
  vm.runInContext(adapterSource, context);
  return context.__GPTLOCK_PAGE_MODEL_EVIDENCE__;
}

test('visible DOM text cannot manufacture arbitrary GPT-5.6 Sol suffix IDs', () => {
  const adapter = loadAdapter();
  for (const label of ['GPT 5.6 S', 'GPT 5.6 So', 'GPT 5.6 Solji', 'GPT 5.6 Soljin', 'GPT 5.6 Solmo']) {
    const model = adapter.modelFromText(label);
    assert.notEqual(model, 'gpt-5.6-s');
    assert.notEqual(model, 'gpt-5.6-so');
    assert.notEqual(model, 'gpt-5.6-solji');
    assert.notEqual(model, 'gpt-5.6-soljin');
    assert.notEqual(model, 'gpt-5.6-solmo');
  }
  assert.equal(adapter.modelFromText('GPT-5.6 Sol'), 'gpt-5.6-sol');
  assert.equal(adapter.modelFromText('gpt-5.6-sol-wm'), 'gpt-5.6-sol');
});

test('persistent discovery is network-authoritative and DOM-only observations are not stored', () => {
  assert.match(catalogSource, /function trustedModelCandidates/);
  assert.match(catalogSource, /network_request_metadata/);
  assert.match(catalogSource, /network_response_metadata/);
  assert.doesNotMatch(catalogSource, /if \(model\) rememberModels\(\[model\]\)/);
  assert.match(catalogSource, /Page DOM remains useful for the live indicator/);
});

test('legacy polluted Sol fragments are migrated out of discoveries and locked policy', () => {
  assert.match(optionsSource, /function legacySuspiciousModel/);
  assert.match(optionsSource, /gpt-5\\\.6-\(\?:s\|so\)/);
  assert.match(optionsSource, /patch\.policy = \{ \.\.\.stored\.policy, lockedModels \}/);
  assert.match(optionsSource, /removeDuplicateDiscoveredRows/);
});

test('locked model cards distinguish manually added models from automatically discovered models', () => {
  assert.match(optionsSource, /手动添加 \/ Manual/);
  assert.match(optionsSource, /自动获取 \/ Auto discovered/);
  assert.match(optionsSource, /function sourceDetail/);
  assert.match(optionsSource, /function labelChoiceSources/);
  assert.match(optionsSource, /evidenceLabel\(model, evidence\)/);
});

test('trusted network evidence can restore a future model that resembles a legacy artifact', () => {
  assert.match(catalogSource, /function hasTrustedNetworkEvidence/);
  assert.match(catalogSource, /!legacySuspiciousModel\(model\) \|\| hasTrustedNetworkEvidence\(item\)/);
  assert.match(optionsSource, /const trusted = \(model\) => hasTrustedNetworkEvidence/);
  assert.match(optionsSource, /!legacySuspiciousModel\(model\) \|\| trusted\(model\)/);
});
