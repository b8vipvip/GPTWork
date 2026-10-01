import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const background = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../../packaging/windows/GPTWork.iss', import.meta.url), 'utf8');

const start = source.indexOf('function normalizeDisplayedModel(text)');
const end = source.indexOf('\n  function ', start + 1);
assert.ok(start >= 0 && end > start, 'normalizeDisplayedModel must remain extractable');
const fnSource = source.slice(start, end);
const normalizeDisplayedModel = Function(`${fnSource}; return normalizeDisplayedModel;`)();

test('v0.5.163 keeps ChatGPT deprecation copy out of the canonical model id', () => {
  assert.equal(normalizeDisplayedModel('GPT-5.5 Leaving on October 14'), 'gpt-5.5');
  assert.equal(normalizeDisplayedModel('GPT-5.5'), 'gpt-5.5');
  assert.equal(normalizeDisplayedModel('GPT-5.6 Sol'), 'gpt-5.6-sol');
  assert.equal(normalizeDisplayedModel('GPT-6 Astra'), 'gpt-6-astra');
});

test('release surfaces stay synchronized after the v0.5.163 compatibility fix', () => {
  const escapedVersion = manifest.version.replaceAll('.', '\\.');
  assert.equal(pkg.version, manifest.version);
  assert.match(background, new RegExp(`const RUNTIME_CODE_VERSION = '${escapedVersion}';`));
  assert.match(installer, new RegExp(`#define MyAppVersion "${escapedVersion}"`));
});

test('deprecation-label compatibility is narrow and keeps the exact default Chat pair contract', () => {
  const helperStart = source.indexOf('function defaultChatDirectModelRows(picker, { requireInteraction = true } = {})');
  const helperEnd = source.indexOf('function advancedPickerView(picker)', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /semanticRows\.filter\(interactionVisible\)/);
  assert.match(helper, /models\.has\('gpt-5\.5'\)/);
  assert.match(helper, /models\.has\('gpt-5\.6-sol'\)/);
});
