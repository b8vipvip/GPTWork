// Regression based on the 2026-10-08 field logs: the normal Chat picker has
// GPT-6, GPT-5.6 Sol, GPT-5.5. Three rows are still Chat, not Work.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const [content, background] = await Promise.all([
  readFile(new URL('../content.js', import.meta.url), 'utf8'),
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
]);

function block(source, first, last) {
  const a = source.indexOf(first), b = source.indexOf(last,a);
  assert.ok(a >= 0 && b > a, 'expected one named owner ' + first);
  return source.slice(a,b);
}

test('the owned Chat model catalog includes its newly introduced GPT-6 row', () => {
  const classifier = block(content, 'const DIRECT_CHAT_MODEL_IDS', 'function advancedPickerView');
  assert.match(classifier, /\['gpt-6', 'gpt-5\.6-sol', 'gpt-5\.5'\]/);
  assert.match(classifier, /allModels\.some\(\(model\) => !DIRECT_CHAT_MODEL_IDS\.has\(model\)\)/);
  assert.match(classifier, /return rows\.length >= 2 \? rows : \[\]/);
  assert.doesNotMatch(classifier, /models\.size !== 2/);
});

test('the advanced owned picker does not convert a third Chat row into Picker B', () => {
  const source = block(content, 'async function openModernModelMenu', 'function rowModelDescriptor');
  assert.match(source, /if \(redesignedDirectRows\.length >= 2\)/);
  assert.match(source, /if \(chatRows\.length >= 2\) return \{ pickerMode: 'A', rows: chatRows \}/);
  assert.match(source, /ownedModels\.some\(\(model\) => model && !DIRECT_CHAT_MODEL_IDS\.has\(model\)\)/);
  assert.doesNotMatch(source, /exactChatPair/);
});

test('official Work mode entry cannot click Work twice while the first transition is pending', () => {
  const source = block(content, 'async function enterVerificationWorkMode()', 'async function stopStaleGeneration()');
  assert.equal((source.match(/trustedPointer\(control, 'click'/g) || []).length, 1);
  assert.match(source, /verification-work-mode:single-transition/);
  assert.match(source, /waitUntil\(\(\) => \{/);
  assert.doesNotMatch(source, /for \(let attempt/);
});

test('Work discovery only bootstraps after its mode has already been proven', () => {
  const source = block(background, 'async function discoverOfficialWorkModels', 'async function publishAccountModels');
  assert.match(source, /scanForPickerB\(12000\)/);
  assert.match(source, /url: 'https:\/\/chatgpt\.com\/',\s*active: true/);
  assert.match(source, /await chrome\.tabs\.update\(sourceTabId, \{ active: true \}\)/);
  assert.doesNotMatch(source, /official_work_model_discovery_activation_fallback/);
  assert.match(source, /if \(enter\?\.entered === true && discovered\?\.pickerMode !== 'B'\)/);
  assert.match(source, /official_work_model_discovery_unavailable/);
});

test('official Work incomplete remains an incomplete pipeline outcome', () => {
  assert.match(background, /progress\.officialWorkStageCompleted = Boolean/);
  assert.match(background, /official_work_model_discovery_incomplete/);
});
