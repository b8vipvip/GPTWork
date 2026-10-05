import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('shared and local discoveries become network-only verification candidates', async () => {
  const background = await read('background.js');
  assert.match(background, /const NETWORK_CANDIDATE_SELECTOR = '__network_candidate__'/);
  assert.match(background, /mergeCatalog\(networkCandidateCatalog\(sharedCandidates, 'shared-server'\), 'shared-network-candidates'\)/);
  assert.match(background, /mergeCatalog\(networkCandidateCatalog\(localNetworkCandidates, 'local-network-evidence'\), 'local-network-candidates'\)/);
  assert.match(background, /item\.selectorKey === '__work_transport__' \|\| item\.selectorKey === NETWORK_CANDIDATE_SELECTOR/);
  assert.match(background, /verification_network_candidate_probe/);
});

test('native Work is only a bounded Picker-B discovery transaction and returns to Chat', async () => {
  const background = await read('background.js');
  const controller = await read('work-mode-controller.js');
  assert.match(background, /async function discoverNativeWorkCandidates\(tabId, progress\)/);
  assert.match(background, /GPTWORK_DISCOVERY_ENTER_NATIVE_WORK/);
  assert.match(background, /GPTWORK_DISCOVERY_EXIT_NATIVE_WORK/);
  assert.match(background, /mergeCatalog\(nativeCandidates, 'native-picker-b-discovery'\)/);
  assert.match(background, /networkCandidateCatalog\(discovered\.rows, 'native-picker-b'\)/);
  assert.match(controller, /async function enterNativeWorkDiscovery\(\)/);
  assert.match(controller, /async function exitNativeWorkDiscovery\(\)/);
  assert.match(controller, /topModeControl\('work'\)/);
  assert.match(controller, /topModeControl\('chat'\)/);
  assert.match(controller, /!isPristineNewChat\(\) \|\| nativeDiscoveryOwned/);
});

test('normal Work execution remains network-layer after discovery', async () => {
  const background = await read('background.js');
  assert.match(background, /source: 'network_work_transport'/);
  assert.match(background, /selectorKey: '__work_transport__'/);
  assert.match(background, /Request\/response evidence remains the terminal authority/);
});
