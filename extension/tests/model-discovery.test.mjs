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


test('auto verification can discover account catalog and use a visible naming fallback for unresolved IDs', async () => {
  const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const backgroundSource = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const networkSource = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');
  assert.match(contentSource, /GPTLOCK_DISCOVER_ACCOUNT_MODELS/);
  assert.match(contentSource, /GPTLOCK_AUTO_RESOLVE_MODEL_NAMES/);
  assert.match(backgroundSource, /account_model_catalog_discovered/);
  assert.match(backgroundSource, /model_name_fallback_completed/);
  assert.match(backgroundSource, /gptworkModelNameMappingsV1/);
  assert.match(contentSource, /GPTLOCK_VERIFY_ACCOUNT_MODEL/);
  assert.match(contentSource, /role="menuitemradio"/);
  assert.match(contentSource, /button\.__composer-pill\[aria-haspopup="menu"\]/);
  assert.match(contentSource, /composer-intelligence-picker-content/);
  assert.match(contentSource, /composer-model-picker-slider-advanced-view/);
  assert.match(contentSource, /GPTLOCK_TRUSTED_POINTER/);
  assert.match(contentSource, /unresolvedLatest/);
  assert.match(contentSource, /selectorKey/);
  assert.match(backgroundSource, /currentSelectorKey/);
  assert.match(backgroundSource, /verificationTransactionForTab/);
  assert.match(backgroundSource, /networkMonitor\.trustedPointer/);
  assert.match(backgroundSource, /account_model_verification_started/);
  assert.match(backgroundSource, /account_model_verification_model_completed/);
  assert.match(backgroundSource, /account_model_verification_completed/);
  assert.match(contentSource, /selectModelForVerification/);
  assert.match(contentSource, /selectionAttempted/);
  assert.match(backgroundSource, /body forwarded at Fetch\.requestPaused is the sole request-confirmation/);
  assert.match(backgroundSource, /responseConfirmed/);
  assert.match(backgroundSource, /getVerificationTransaction\(tabId\)/);
  assert.match(backgroundSource, /fetch_forwarded_request_metadata/);
  assert.doesNotMatch(backgroundSource, /Model selection was not confirmed/);
  assert.match(backgroundSource, /probeMarker: 'GPTWork 模型验证'/);
  assert.match(backgroundSource, /skipAlignment: true/);
  assert.match(backgroundSource, /runtimePolicyForTabSync/);
  assert.match(backgroundSource, /preserveModel: false/);
  assert.match(networkSource, /preserveReasoning: true/);
  assert.match(networkSource, /bypassRewrite: false/);
  assert.match(backgroundSource, /Account-menu DOM is discovery input, not authoritative persistence/);
  assert.doesNotMatch(backgroundSource, /sources: \[\.\.\.new Set\(\[\.\.\.\(Array\.isArray\(prior\.sources\).*account_model_catalog/s);
});


test('v0.5.108 model indicator avoids whole-page button scans and high-frequency polling', () => {
  assert.doesNotMatch(catalogSource, /querySelectorAll\('button,\[role="button"\]'\)/);
  assert.match(catalogSource, /const STATE_REFRESH_MS = 10000/);
  assert.match(catalogSource, /pageModelSelector/);
  assert.doesNotMatch(catalogSource, /characterData: true/);
});
