import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');

test('v0.5.181 classifies the redesigned expanded owned model list as Picker B', () => {
  const start = content.indexOf('async function openModernModelMenu');
  const end = content.indexOf('function rowModelDescriptor', start);
  assert.ok(start >= 0 && end > start);
  const body = content.slice(start, end);

  assert.match(body, /picker-mode-b-redesigned-owned-model-list/);
  assert.match(body, /const ownedRows = distinctModelRows\(picker\)/);
  assert.match(body, /ownedRows\.length >= 2 && !exactChatPair/);
  assert.match(body, /return \{ pickerMode: 'B', rows: ownedRows \}/);
});

test('v0.5.181 keeps the exact Chat pair as Picker A and does not mislabel unresolved Work transitions', () => {
  const start = content.indexOf('async function openModernModelMenu');
  const end = content.indexOf('function rowModelDescriptor', start);
  const body = content.slice(start, end);

  assert.match(body, /ownedModels\.has\('gpt-5\.5'\)/);
  assert.match(body, /ownedModels\.has\('gpt-5\.6-sol'\)/);
  assert.match(body, /pickerMode: null/);
  assert.doesNotMatch(
    body.slice(body.indexOf("picker-redesign-model-view-unresolved"), body.indexOf("const initialOpener")),
    /pickerMode: 'A'/
  );
});
