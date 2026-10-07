import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('server and local historical models do not seed a v0.5.176 discovery transaction', async () => {
  const background = await read('background.js');
  assert.match(background, /ignoredSeedCandidates/);
  assert.match(background, /sharedCandidates: \[\]/);
  assert.match(background, /localNetworkCandidates: \[\]/);
  assert.doesNotMatch(background, /mergeCatalog\(sharedNetworkCatalog/);
  assert.doesNotMatch(background, /mergeCatalog\(localNetworkCatalog/);
});

test('official Work Picker B is discovered and natively verified on an isolated pristine tab', async () => {
  const background = await read('background.js');
  assert.match(background, /async function discoverOfficialWorkModels\(sourceTabId, progress\)/);
  assert.match(background, /GPTLOCK_VERIFY_ENTER_WORK_MODE/);
  assert.match(background, /url: 'https:\/\/chatgpt\.com\/'/);
  assert.match(background, /active: false/);
  assert.match(background, /isolateTabForNativeDiscovery\(discoveryTabId\)/);
  assert.match(background, /mode: 'observe-native'/);
  assert.match(background, /official_work_model_native_verified/);
  assert.match(background, /nativeRequestModel/);
  assert.match(background, /nativeResponseModel/);
  assert.match(background, /chrome\.tabs\.remove\(discoveryTabId\)/);
});

test('Picker B returns to Chat only as a proven cross-mode transport candidate', async () => {
  const background = await read('background.js');
  assert.match(background, /selectorKey: '__picker_b_chat_lock__'/);
  assert.match(background, /transportModel: item\.nativeRequestModel/);
  assert.match(background, /expectedResponseModel: item\.nativeResponseModel/);
  assert.match(background, /rawRequestModel === expectedTransport/);
  assert.match(background, /rawResponseProtocolModel === expectedResponse/);
  assert.match(background, /chatLockSupported/);
});

test('normal runtime consumes the server-proven protocol map instead of discovery history', async () => {
  const background = await read('background.js');
  const evidence = await read('network-evidence.js');
  assert.match(background, /sharedModelProtocolMap/);
  assert.match(background, /modelTransportMap: Object\.fromEntries\(sharedModelProtocolMap\)/);
  assert.match(evidence, /modelTransportId\(targetModel, configuration\.modelTransportMap\)/);
});
