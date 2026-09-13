import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const catalog = await readFile(new URL('../model-catalog.js', import.meta.url), 'utf8');
const masterUi = await readFile(new URL('../master-ui-controller.js', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../tab-feature-runtime.js', import.meta.url), 'utf8');

test('model evidence refreshes do not perform the same sync write every 1.2 seconds', () => {
  assert.match(catalog, /lastRememberedFingerprint/);
  assert.match(catalog, /pendingRememberedFingerprint/);
  assert.match(catalog, /fingerprint === lastRememberedFingerprint/);
  assert.match(catalog, /previous\.confirmed === true && previousSources\.includes\(source\)/);
  assert.match(catalog, /if \(changed\) \{\s*await chrome\.storage\.sync\.set/);
  assert.match(catalog, /modelDiscoveryRetryAt = Date\.now\(\) \+ 60_000/);
});

test('master toggle is local runtime state and never directly consumes sync write quota', () => {
  assert.match(masterUi, /GPTWORK_MASTER_SET/);
  assert.doesNotMatch(masterUi, /chrome\.storage\.sync\.set/);
  assert.match(runtime, /MASTER_KEY = 'gptworkEnabledLocal'/);
  assert.match(runtime, /chrome\.storage\.local\.set\(\{ \[MASTER_KEY\]: desired \}\)/);
  const masterBlock = runtime.match(/if \(message\.type === 'GPTWORK_MASTER_SET'\) \{([\s\S]*?)\n  \}\n\n  throw new Error/);
  assert.ok(masterBlock, 'master setter must remain explicit');
  assert.doesNotMatch(masterBlock[1], /chrome\.storage\.sync\.set/);
});
