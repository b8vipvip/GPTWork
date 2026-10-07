import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const monitor = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');


test('Picker-B Chat compatibility keeps an explicit force-transport transaction as terminal authority', () => {
  const start = background.indexOf('async function verifyAccountCatalogModels');
  const end = background.indexOf('function modelVerificationHistoryRecord', start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);
  assert.match(block, /mode: chatCompatibility \? 'force-transport' : 'observe-native'/);
  assert.match(block, /transportModel: chatCompatibility \? item\.transportModel : null/);
  assert.match(monitor, /\? 'model-discovery-chat-compat'/);
  assert.match(monitor, /forceTransportModel: transportModel/);
});


test('v0.5.176 Work phase requires official Picker-B discovery rather than a synthetic network seed', () => {
  assert.match(background, /async function discoverOfficialWorkModels/);
  assert.match(background, /official_work_model_discovery_tab_created/);
  assert.match(background, /official_work_model_native_verified/);
  assert.match(background, /picker-b-chat-compatibility/);
  assert.doesNotMatch(background, /network_work_catalog_seeded/);
});
