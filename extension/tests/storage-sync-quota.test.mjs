import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const catalog = await readFile(new URL('../model-catalog.js', import.meta.url), 'utf8');
const controller = await readFile(new URL('../enabled-toggle-controller.js', import.meta.url), 'utf8');

test('model evidence refreshes do not perform the same sync write every 1.2 seconds', () => {
  assert.match(catalog, /lastRememberedFingerprint/);
  assert.match(catalog, /pendingRememberedFingerprint/);
  assert.match(catalog, /fingerprint === lastRememberedFingerprint/);
  assert.match(catalog, /previous\.confirmed === true && previousSources\.includes\(source\)/);
  assert.match(catalog, /if \(changed\) \{\s*await chrome\.storage\.sync\.set/);
  assert.match(catalog, /modelDiscoveryRetryAt = Date\.now\(\) \+ 60_000/);
});

test('master toggle itself never directly consumes chrome.storage.sync write quota', () => {
  assert.match(controller, /chrome\.storage\.local\.set/);
  assert.doesNotMatch(controller, /chrome\.storage\.sync\.set/);
  assert.match(controller, /MAX_WRITE_OPERATIONS_PER_HOUR/);
});
