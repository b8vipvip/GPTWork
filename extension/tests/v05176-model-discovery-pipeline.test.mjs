import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  normalizeModelId,
  normalizeRawProtocolModelId,
} from '../policy.js';
import {
  extractRequestEvidence,
  extractResponseEvidence,
} from '../network-evidence.js';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('v0.5.176 keeps protocol identity separate from business model identity', () => {
  assert.equal(normalizeRawProtocolModelId('gpt-5-6-thinking'), 'gpt-5.6-thinking');
  assert.equal(normalizeModelId('gpt-5-6-thinking'), 'gpt-5.6-thinking');
  assert.notEqual(normalizeModelId('gpt-5-6-thinking'), 'gpt-5.6-sol');

  assert.equal(normalizeRawProtocolModelId('gpt-6-astra-wm'), 'gpt-6-astra-wm');
  assert.equal(normalizeModelId('gpt-6-astra-wm'), 'gpt-6-astra');

  const request = extractRequestEvidence('{"model":"gpt-6-astra-wm","thinking_effort":"high"}');
  assert.equal(request.model, 'gpt-6-astra');
  assert.equal(request.rawModel, 'gpt-6-astra-wm');

  const response = extractResponseEvidence({
    body: JSON.stringify({ message: { metadata: { resolved_model_slug: 'gpt-5-6-thinking' } } }),
    mimeType: 'application/json',
  });
  assert.equal(response.model, 'gpt-5.6-thinking');
  assert.equal(response.rawModel, 'gpt-5.6-thinking');
});

test('v0.5.176 discovers Picker B in official ChatGPT Work independently from GPTWork Work availability', async () => {
  const background = await read('background.js');
  const bodyStart = background.indexOf('async function discoverOfficialWorkModels');
  const bodyEnd = background.indexOf('async function publishAccountModels', bodyStart);
  const body = background.slice(bodyStart, bodyEnd);
  const enterStart = background.indexOf('async function enterNativeWorkOnDiscoveryTab');
  const enterEnd = background.indexOf('async function waitForNetworkModelEvidence', enterStart);
  const enterBody = background.slice(enterStart, enterEnd);

  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart);
  assert.ok(enterStart >= 0 && enterEnd > enterStart);
  assert.match(body, /enterNativeWorkOnDiscoveryTab\(discoveryTabId,/);
  assert.match(enterBody, /type: 'GPTLOCK_VERIFY_ENTER_WORK_MODE'/);
  assert.match(enterBody, /response\?\.confirmed === true \|\| response\?\.alreadySelected === true/);
  assert.match(body, /isolateTabForNativeDiscovery\(discoveryTabId\)/);
  assert.match(body, /mode: 'observe-native'/);
  assert.match(body, /official_work_model_native_verified/);
  assert.match(body, /nativeRequestModel/);
  assert.match(body, /nativeResponseModel/);
  assert.doesNotMatch(body, /serverWorkFeatureEnabled\(\)/);
  assert.doesNotMatch(body, /networkCandidateCatalog\(discovered\.rows/);
});

test('v0.5.176 returns verified Picker B models to Chat for cross-mode lock proof', async () => {
  const background = await read('background.js');
  assert.match(background, /selectorKey: '__picker_b_chat_lock__'/);
  assert.match(background, /mode: chatCompatibility \? 'force-transport' : 'observe-native'/);
  assert.match(background, /picker_b_chat_compatibility_started/);
  assert.match(background, /rawRequestModel === expectedTransport/);
  assert.match(background, /rawResponseProtocolModel === expectedResponse/);
  assert.match(background, /chatLockSupported: chatCompatibility \? verified : false/);
});

test('v0.5.176 network monitor has distinct native-observation and Chat-force authorities', async () => {
  const monitor = await read('network-monitor.js');
  assert.match(monitor, /transaction\?\.mode === 'observe-native'/);
  assert.match(monitor, /authorityKind: 'model-discovery-native'/);
  assert.match(monitor, /bypassRewrite: true/);
  assert.match(monitor, /model-discovery-chat-compat/);
  assert.match(monitor, /authorityTransportModel: transportModel/);
  assert.match(monitor, /rewrite\.transportModelAfter/);
});

test('v0.5.176 discovery does not use server history as candidate seed', async () => {
  const background = await read('background.js');
  const autoStart = background.indexOf('async function autoVerify');
  const autoEnd = background.indexOf('function diagnosticTabState', autoStart);
  const body = background.slice(autoStart, autoEnd);
  assert.match(body, /server catalog only so normal runtime can restore previously/);
  assert.match(body, /sharedCandidates: \[\]/);
  assert.match(body, /localNetworkCandidates: \[\]/);
  assert.match(body, /accountCatalog = await discoverAccountCatalog\(tabId\)/);
});

test('v0.5.176 normal model locking consumes only proven Picker-B Chat transport', async () => {
  const background = await read('background.js');
  const evidence = await read('network-evidence.js');
  assert.match(background, /item\.chatTransportModel \|\| \(item\.pickerMode === 'A' \? item\.nativeRequestModel : null\)/);
  assert.match(background, /if \(item\?\.chatLockSupported === true\)/);
  assert.match(background, /modelTransportMap: Object\.fromEntries\(sharedModelProtocolMap\)/);
  assert.match(evidence, /modelTransportId\(targetModel, configuration\.modelTransportMap\)/);
});

test('v0.5.176 server persists native and Chat compatibility protocol evidence', async () => {
  const server = await read('../license-server/account-system-base.mjs');
  assert.match(server, /native_request_model/);
  assert.match(server, /native_response_model/);
  assert.match(server, /chat_transport_model/);
  assert.match(server, /chat_response_model/);
  assert.match(server, /chat_lock_response_confirmed/);
  assert.match(server, /chat_lock_verified_count/);
  assert.match(server, /chatLockResponseConfirmed/);
});

test('v0.5.176 user-facing action is Discover Models', async () => {
  const popup = await read('popup-v0513.html');
  const settings = await read('settings-v0521.html');
  assert.match(popup, />发现模型<\/button>/);
  assert.match(settings, /发现模型记录/);
});
