import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('verification Work bootstrap resolves the effective Work policy without a parallel tab Set', () => {
  const start = background.indexOf('function workBootstrapModelForTab(tabId) {');
  const end = background.indexOf('function beginWorkBootstrapTransaction', start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);
  assert.match(block, /effectivePolicyForTabSync\(tabId\)/);
  assert.match(block, /normalizeConcreteModelId\(policy\.lockedModels\?\.\[0\]\)/);
  assert.match(block, /normalizeConcreteModelId\(DEFAULT_POLICY\.lockedModels\?\.\[0\]\)/);
  assert.doesNotMatch(background, /workBootstrapTabs/);
});

test('failed Work discovery cannot be reported as a fully verified account', () => {
  assert.match(background, /catalogVerification\?\.workDiscovery\?\.attempted === true/);
  assert.match(background, /catalogVerification\.workDiscovery\.entered !== true/);
  assert.match(background, /finalReason = 'work_model_discovery_incomplete'/);
});
