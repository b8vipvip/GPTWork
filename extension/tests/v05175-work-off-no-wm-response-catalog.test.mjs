import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('v0.5.175 Work-off verification never seeds a Work transport network candidate', async () => {
  const background = await read('background.js');
  assert.match(background, /function serverWorkFeatureEnabled\(\)/);
  assert.match(background, /serverFeatureSettingsReady === true && currentSettings\.workModeFeatureEnabled === true/);
  assert.match(background, /const allowWorkTransport = serverWorkFeatureEnabled\(\)/);
  assert.match(background, /modelTransportId\(model\) !== model/);
  assert.match(background, /skippedWorkTransportModels\.push\(model\)/);
  assert.match(background, /work_transport_candidates_skipped/);
  assert.match(background, /reason: 'work_feature_disabled'/);
});

test('v0.5.175 page settings remain Work-disabled until live server control is applied', async () => {
  const background = await read('background.js');
  assert.match(background, /let serverFeatureSettingsReady = false/);
  assert.match(background, /serverFeatureSettingsReady = true/);
  assert.match(background, /const workModeFeatureEnabled = serverWorkFeatureEnabled\(\)/);
  assert.match(background, /serverFeatureSettingsReady = false;[\s\S]*accountClient\.snapshot/);
  assert.match(background, /accountClient\.logout\(\);[\s\S]*serverFeatureSettingsReady = false/);
});

test('v0.5.175 does not republish a request-only shared candidate as a new discovery', async () => {
  const background = await read('background.js');
  assert.match(background, /if \(!existing && !pickerDiscovered && !responseConfirmed\) continue/);
  assert.match(background, /A shared\/network candidate is not a new discovery merely because Fetch/);
  assert.match(background, /responseConfirmed: models\.filter\(\(item\) => item\.responseConfirmed\)\.length/);
});

test('v0.5.175 sync trusts only Picker-discovered or strict response-verified shared models', async () => {
  const background = await read('background.js');
  assert.match(background, /item\.verifiedCount > 0 \|\| \['A', 'B'\]\.includes\(item\.pickerMode\)/);
  assert.match(background, /Legacy request-only rows remain/);
});
