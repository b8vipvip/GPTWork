import fs from 'node:fs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('model auto-lock helper is loaded after model discovery', () => {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  const discovery = scripts.indexOf('model-catalog.js');
  const autoLock = scripts.indexOf('model-auto-lock.js');
  assert.ok(discovery >= 0);
  assert.ok(autoLock > discovery);
});


test('page model evidence recognizes verified Work model family labels', () => {
  const evidence = fs.readFileSync(new URL('../page-model-evidence.js', import.meta.url), 'utf8');
  for (const model of ['gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-5.6-terra','gpt-5.6-luna']) assert.match(evidence, new RegExp(model.replaceAll('.', '\\\.')));
  assert.match(evidence, /'gpt-6-astra': \['gpt-6 astra'/);
});
