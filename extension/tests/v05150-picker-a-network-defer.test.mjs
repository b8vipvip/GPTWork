import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('Picker A network defer remains available only when the requested model is already page-confirmed', () => {
  const start = content.indexOf("const attempted = await modelPickerPointer(candidate, 'click', 'verification-model-row')");
  const end = content.indexOf('// Never keep using the pre-click row as a liveness authority.', start);
  assert.ok(start >= 0 && end > start);
  const block = content.slice(start, end);
  assert.match(block, /networkDeferredAfterPointerReject = modern\.pickerMode === 'A'/);
  assert.match(block, /observation\.model === desired/);
  assert.match(block, /candidate\.isConnected/);
  assert.match(block, /modern\.picker\?\.contains\?\.\(candidate\) === true/);
  assert.match(block, /owned_picker_a_row_pointer_hit_test_unavailable/);
});

test('Picker B and trusted-pointer ownership stay strict', () => {
  assert.match(content, /if \(!networkDeferredAfterPointerReject\) return \{ attempted: false/);
  assert.match(content, /function pointerStillOwnsPoint/);
  assert.match(content, /hit === element \|\| element\.contains\?\.\(hit\)/);
  assert.match(content, /rejected_unstable_hit_test/);
  assert.match(background, /if \(selection\.selectionAttempted !== true && item\.pickerMode === 'B'/);
  assert.match(background, /if \(!transportOnly && selection\.selectionAttempted !== true\) throw new Error\('Model selection control was not activated'\)/);
});
