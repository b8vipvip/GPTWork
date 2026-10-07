import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('v0.5.176 protocol model candidates are independent from the GPTWork Work feature gate', async () => {
  const background = await read('background.js');
  const start = background.indexOf('function networkCandidateCatalog');
  const end = background.indexOf('async function loadTrustedLocalNetworkCandidates', start);
  const body = background.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(body, /serverWorkFeatureEnabled/);
  assert.doesNotMatch(body, /work_transport_candidates_skipped/);
  assert.doesNotMatch(body, /modelTransportId\(model\) !== model/);
});

test('server Work settings remain fail-inert for GPTWork runtime features only', async () => {
  const background = await read('background.js');
  assert.match(background, /let serverFeatureSettingsReady = false/);
  assert.match(background, /serverFeatureSettingsReady = true/);
  assert.match(background, /const workModeFeatureEnabled = serverWorkFeatureEnabled\(\)/);
  assert.match(background, /serverFeatureSettingsReady = false;[\s\S]*accountClient\.snapshot/);
  assert.match(background, /accountClient\.logout\(\);[\s\S]*serverFeatureSettingsReady = false/);
});

test('model discovery publishes Picker/native evidence rather than request-only server seeds', async () => {
  const background = await read('background.js');
  assert.match(background, /Discovery itself never uses server history as/);
  assert.match(background, /sharedCandidates: \[\]/);
  assert.match(background, /localNetworkCandidates: \[\]/);
  assert.match(background, /officialWorkDiscovery/);
  assert.match(background, /chatLockSupported/);
});

test('shared catalog still requires Picker discovery or strict response verification', async () => {
  const background = await read('background.js');
  assert.match(background, /item\.verifiedCount > 0 \|\| \['A', 'B'\]\.includes\(item\.pickerMode\)/);
  assert.match(background, /Legacy request-only rows remain/);
});
