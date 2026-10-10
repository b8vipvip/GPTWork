import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runtime = await readFile(new URL('../tab-feature-runtime.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('Work policy has a configurable floor and preserves eligible page models', () => {
  assert.match(runtime, /export const DEFAULT_WORK_MODEL = 'gpt-6-astra'/);
  assert.match(runtime, /prioritizeModels\(\[normalized, normalizedFloor\]\)\[0\] === normalized/);
  assert.match(runtime, /isAtLeastWorkFloor\(selected, floor\) \? selected : floor/);
  assert.doesNotMatch(runtime, /isAtLeastSol\(/);
});


test('Picker A verification does not require official Work completion', () => {
  const auto = background.slice(background.indexOf('async function autoVerify'), background.indexOf('function diagnosticTabState'));
  assert.match(auto, /summarizeVerificationOutcome\(catalogVerification\)/);
  assert.doesNotMatch(auto, /official_work_model_discovery_incomplete/);
  assert.doesNotMatch(auto, /officialWorkDiscovery\.entered/);
});
