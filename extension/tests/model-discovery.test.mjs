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

test('exact future-tier labels are accepted while lifecycle copy is rejected', () => {
  const adapter = loadAdapter();
  assert.equal(adapter.modelFromText('GPT 5.6 So'), 'gpt-5.6-so');
  assert.equal(adapter.modelFromText('GPT 7 Nova'), 'gpt-7-nova');
  assert.equal(adapter.modelFromText('GPT 8 Orion'), 'gpt-8-orion');
  assert.equal(adapter.modelFromText('GPT-5.6 Sol'), 'gpt-5.6-sol');
  assert.equal(adapter.modelFromText('gpt-5.6-sol-wm'), 'gpt-5.6-sol');
  assert.equal(adapter.modelFromText('GPT-5.5 Leaving on October 14'), null);
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

test('locked model cards distinguish built-in models from automatically discovered models', () => {
  assert.match(optionsSource, /内置模型 \/ Built-in/);
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



test('model discovery observes native Chat/Work evidence and preserves visible naming fallback', async () => {
  const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const backgroundSource = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const networkSource = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');
  assert.match(contentSource, /GPTLOCK_DISCOVER_ACCOUNT_MODELS/);
  assert.match(contentSource, /GPTLOCK_AUTO_RESOLVE_MODEL_NAMES/);
  assert.match(backgroundSource, /model_name_fallback_completed/);
  assert.match(backgroundSource, /gptworkModelNameMappingsV1/);
  assert.match(backgroundSource, /model_discovery_started/);
  assert.match(backgroundSource, /model_discovery_completed/);
  assert.match(backgroundSource, /async function discoverOfficialWorkModels/);
  assert.match(backgroundSource, /picker_b_chat_compatibility_started/);
  assert.match(contentSource, /GPTLOCK_VERIFY_ACCOUNT_MODEL/);
  assert.match(contentSource, /GPTLOCK_TRUSTED_POINTER/);
  assert.match(backgroundSource, /Only a directly observed network response field/);
  assert.match(networkSource, /transaction\?\.mode === 'observe-native'/);
  assert.match(networkSource, /model-discovery-chat-compat/);
  assert.doesNotMatch(backgroundSource, /work_profile_confirmed_by_default_model_slug/);
  assert.doesNotMatch(backgroundSource, /network_work_catalog_seeded/);
});

test('v0.5.108 model indicator avoids whole-page button scans and high-frequency polling', () => {
  assert.doesNotMatch(catalogSource, /querySelectorAll\('button,\[role="button"\]'\)/);
  assert.match(catalogSource, /const STATE_REFRESH_MS = 10000/);
  assert.match(catalogSource, /pageModelSelector/);
  assert.doesNotMatch(catalogSource, /characterData: true/);
});
