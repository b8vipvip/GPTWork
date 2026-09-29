import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cargoToml = await readFile(new URL('../../native-core/Cargo.toml', import.meta.url), 'utf8');
const cargoLock = await readFile(new URL('../../native-core/Cargo.lock', import.meta.url), 'utf8');
const installer = await readFile(new URL('../../packaging/windows/GPTWork.iss', import.meta.url), 'utf8');

test('v0.5.150 defers only the exact owned redesigned Picker A row when trusted hit-testing is unavailable', () => {
  const start = content.indexOf("const attempted = await modelPickerPointer(candidate, 'click', 'verification-model-row')");
  const end = content.indexOf('// Never keep using the pre-click row as a liveness authority.', start);
  assert.ok(start >= 0 && end > start);
  const block = content.slice(start, end);
  assert.match(block, /networkDeferredAfterPointerReject = modern\.pickerMode === 'A'/);
  assert.match(block, /desired === 'gpt-5\.5' \|\| desired === 'gpt-5\.6-sol'/);
  assert.match(block, /candidate\.isConnected/);
  assert.match(block, /visible\(candidate\)/);
  assert.match(block, /modern\.picker\?\.contains\?\.\(candidate\) === true/);
  assert.match(block, /owned_picker_a_row_pointer_hit_test_unavailable/);
  assert.match(block, /return \{ attempted: true, observation, uiConfirmed: false, networkDeferred: true \}/);
});

test('v0.5.150 keeps Picker B and trusted-pointer ownership strict', () => {
  assert.match(content, /if \(!networkDeferredAfterPointerReject\) return \{ attempted: false/);
  assert.match(content, /function pointerStillOwnsPoint/);
  assert.match(content, /hit === element \|\| element\.contains\?\.\(hit\)/);
  assert.match(content, /rejected_unstable_hit_test/);
  assert.match(background, /if \(selection\.selectionAttempted !== true && item\.pickerMode === 'B'/);
  assert.match(background, /if \(!transportOnly && selection\.selectionAttempted !== true\) throw new Error\('Model selection control was not activated'\)/);
});

test('v0.5.150 release version surfaces stay synchronized', () => {
  assert.equal(manifest.version, '0.5.150');
  assert.equal(pkg.version, '0.5.150');
  assert.match(background, /const RUNTIME_CODE_VERSION = '0\.5\.150'/);
  assert.match(cargoToml, /version = "0\.5\.150"/);
  assert.match(cargoLock, /name = "gptwork-core"\nversion = "0\.5\.150"/);
  assert.match(installer, /#define MyAppVersion "0\.5\.150"/);
});
