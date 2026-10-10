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
  assert.match(block, /mode: chatCompatibility \? 'picker-a-ui-lock' : 'observe-native'/);
  assert.match(block, /transportModel: chatCompatibility \? item\.transportModel : null/);
  assert.match(monitor, /\? 'model-discovery-chat-compat'/);
  assert.match(monitor, /forceTransportModel: transportModel/);
});


test('legacy Picker B helper remains isolated from the A-only verification scheduler', () => {
  assert.match(background, /async function discoverOfficialWorkModels/);
  const body = background.slice(background.indexOf('async function verifyAccountCatalogModels'), background.indexOf('function modelVerificationHistoryRecord'));
  assert.doesNotMatch(body, /discoverOfficialWorkModels\(tabId, progress\)/);
  assert.match(body, /discoveryMode = 'picker-a-chat-only'/);
  assert.doesNotMatch(body, /picker-b-chat-compatibility/);
  assert.doesNotMatch(background, /network_work_catalog_seeded/);
});
