import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const source = await readFile(new URL('background-update.js', ROOT), 'utf8');

test('popup status reads reconcile stale installed-update recovery errors against live runtime state', () => {
  const handler = source.match(/function handleUpdateMessage\([^]*?\n\}/)?.[0] || '';
  assert.match(handler, /GPTWORK_UPDATE_STATUS_GET/);
  assert.match(handler, /reconcileInstalledRecovery/);
  assert.match(handler, /runtime\.getManifest\(\)\.version/);
  assert.match(handler, /getUpdateStatus/);
});
