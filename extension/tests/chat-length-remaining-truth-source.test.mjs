import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const scripts = manifest.content_scripts?.[0]?.js || [];

test('chat length truth authority loads after the existing remaining estimator', () => {
  const indicatorIndex = scripts.indexOf('chat-length-remaining-indicator.js');
  const truthIndex = scripts.indexOf('chat-length-remaining-truth.js');
  assert.ok(indicatorIndex >= 0);
  assert.ok(truthIndex > indicatorIndex);
});
