import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Regression coverage for the explicit legacy-core maintenance integration of ModelPro v0.1.48 after the v0.5.159 field trace.
const r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('pre-navigation discovery stays hit-test strict and exact ViewTrack navigation can causally reacquire semantic rows', async () => {
  const content = await r('content.js');

  const helperStart = content.indexOf('function defaultChatDirectModelRows(picker, { requireInteraction = true } = {})');
  const helperEnd = content.indexOf('function advancedPickerView(picker)', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = content.slice(helperStart, helperEnd);
  assert.match(helper, /const semanticRows = distinctModelRows\(picker\);/);
  assert.match(helper, /const rows = requireInteraction \? semanticRows\.filter\(interactionVisible\) : semanticRows;/);
  assert.match(helper, /models\.has\('gpt-5\.5'\)/);
  assert.match(helper, /models\.has\('gpt-5\.6-sol'\)/);

  const openStart = content.indexOf('async function openModernModelMenu()');
  const openEnd = content.indexOf('function rowModelDescriptor(row)', openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  const open = content.slice(openStart, openEnd);
  assert.match(open, /let redesignedDirectRows = defaultChatDirectModelRows\(picker\);/);
  assert.match(open, /modelPickerPointer\(modelViewOpener, 'click', 'model-picker-redesign-model-view'\)/);
  assert.match(open, /defaultChatDirectModelRows\(picker, \{ requireInteraction: false \}\)/);
  assert.ok(
    open.indexOf("modelPickerPointer(modelViewOpener, 'click', 'model-picker-redesign-model-view')")
      < open.indexOf('defaultChatDirectModelRows(picker, { requireInteraction: false })'),
    'semantic-only reacquisition must be downstream of the exact owned ViewTrack navigation',
  );
});

test('failed unified picker discovery cannot fabricate a catalog row from the composer summary', async () => {
  const content = await r('content.js');
  const start = content.indexOf('async function discoverAccountModelMetadata()');
  const end = content.indexOf('function diagnosticPerformanceSnapshot', start);
  assert.ok(start >= 0 && end > start);
  const section = content.slice(start, end);
  assert.match(section, /const currentCanJoinCatalog = !modern\.picker \|\| modern\.rows\.length > 0;/);
  assert.match(section, /modern\.pickerMode !== 'B' && currentCanJoinCatalog && current\?\.model/);
  assert.doesNotMatch(section, /modern\.pickerMode !== 'B' && current\?\.model && !models\.some/);
});

test('v0.5.160 consumes ModelPro v0.1.48 without product-neutral verification policy drift', async () => {
  const [sourceText, manifestText, packageText, background] = await Promise.all([
    r('vendor/modelpro/MODELPRO_SOURCE.json'),
    r('manifest.json'),
    r('package.json'),
    r('background.js'),
  ]);
  const source = JSON.parse(sourceText);
  const manifest = JSON.parse(manifestText);
  const pkg = JSON.parse(packageText);
  assert.equal(manifest.version, '0.5.160');
  assert.equal(pkg.version, manifest.version);
  assert.match(background, /const RUNTIME_CODE_VERSION = '0\.5\.160';/);
  assert.equal(source.version, '0.1.48');
  assert.equal(source.commit, 'df7f984bbd9d5b95e06523a228768ae924b16ade');
  assert.equal(source.blob, '5ab85559688ed0b605b517e27eec0682361d035c');
});
