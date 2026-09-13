import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const updater = fs.readFileSync(new URL('../background-update.js', import.meta.url), 'utf8');
const popup = fs.readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const options = fs.readFileSync(new URL('../options-update.js', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../../packaging/windows/GPTWork.iss', import.meta.url), 'utf8');

test('popup and settings are update clients, not update lifecycle authorities', () => {
  for (const source of [popup, options]) {
    assert.match(source, /GPTWORK_UPDATE_STATUS_GET/);
    assert.match(source, /GPTWORK_UPDATE_CHECK/);
    assert.match(source, /GPTWORK_UPDATE_INSTALL/);
    assert.doesNotMatch(source, /connectNative\(/);
    assert.doesNotMatch(source, /chrome\.downloads\.download/);
    assert.doesNotMatch(source, /prepare_update/);
    assert.doesNotMatch(source, /chrome\.runtime\.reload\(/);
  }
  assert.match(updater, /function handleUpdateMessage/);
  assert.match(updater, /nativeRequest\('prepare_update'/);
});

test('Windows Setup stages the new extension and never recursively deletes the live extension', () => {
  assert.match(installer, /DestDir: "\{app\}\\extension\.next"/);
  assert.match(installer, /function SwapExtensionPayload\(\): Boolean/);
  assert.match(installer, /extension\.previous/);
  assert.match(installer, /RollbackExtensionSwap/);
  assert.match(installer, /RecoverInterruptedExtensionSwap/);
  assert.doesNotMatch(installer, /Type: filesandordirs; Name: "\{app\}\\extension"\s*$/m);
  assert.doesNotMatch(installer, /DestDir: "\{app\}\\extension"; Excludes:/);
});

test('the updater quiesces content before launch and restores the canonical Master transactionally', () => {
  const quiesce = updater.match(/async function quiesceForUpdate\([^]*?\n\}/)?.[0] || '';
  assert.match(quiesce, /suspendContentRecovery/);
  assert.match(quiesce, /GPTWORK_CONTENT_PREPARE_RELOAD/);
  assert.match(quiesce, /MASTER_KEY/);
  assert.match(quiesce, /originalMasterEnabled/);
  const restore = updater.match(/async function restoreAfterFailedUpdate\([^]*?\n\}/)?.[0] || '';
  assert.match(restore, /resumeContentRecovery/);
  assert.match(restore, /originalMasterEnabled === true/);
  assert.match(restore, /MASTER_KEY/);
});
