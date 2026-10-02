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

test('failed Work discovery cannot be reported as a fully verified account', () => {
  assert.match(background, /catalogVerification\?\.workDiscovery\?\.attempted === true/);
  assert.match(background, /catalogVerification\.workDiscovery\.entered !== true/);
  assert.match(background, /finalReason = 'work_model_discovery_incomplete'/);
});
