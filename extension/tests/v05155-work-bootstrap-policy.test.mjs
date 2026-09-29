import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('verification Work bootstrap uses effective Work policy while normal traffic keeps page-following policy', () => {
  const start = background.indexOf('getLockConfiguration(tabId) {');
  const end = background.indexOf('getVerificationTransaction(tabId)', start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);

  assert.match(block, /const workBootstrap = workBootstrapTabs\.has\(Number\(tabId\)\)/);
  assert.match(
    block,
    /const policy = workBootstrap\s*\? effectivePolicyForTabSync\(tabId\)\s*: runtimePolicyForTabSync\(tabId\)/,
  );
  assert.match(block, /preferredReasoning: workBootstrap \? null : currentSettings\.preferredReasoning/);
  assert.match(block, /preserveReasoning: workBootstrap/);
});

test('failed Work discovery cannot be reported as a fully verified account', () => {
  assert.match(background, /catalogVerification\?\.workDiscovery\?\.attempted === true/);
  assert.match(background, /catalogVerification\.workDiscovery\.entered !== true/);
  assert.match(background, /finalReason = 'work_model_discovery_incomplete'/);
});
