import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const updater = fs.readFileSync(new URL('../background-update.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const popup = fs.readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const options = fs.readFileSync(new URL('../options-update.js', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../../packaging/windows/GPTWork.iss', import.meta.url), 'utf8');

test('popup and settings are update clients, not update lifecycle authorities', () => {
  // Settings is the interactive update client: it asks the service worker to check/install
  // and renders the authoritative status returned/persisted by background-update.js.
  assert.match(options, /GPTWORK_UPDATE_STATUS_GET/);
  assert.match(options, /GPTWORK_UPDATE_CHECK/);
  assert.match(options, /GPTWORK_UPDATE_INSTALL/);

  // Popup is intentionally display/navigation-only. It observes the same persisted status
  // and sends the user to Settings rather than becoming a second check/install authority.
  assert.match(popup, /gptlockUiUpdateStatus/);
  assert.match(popup, /chrome\.storage\.onChanged/);
  assert.match(popup, /GPTLOCK_OPEN_OPTIONS/);
  assert.doesNotMatch(popup, /GPTWORK_UPDATE_CHECK/);
  assert.doesNotMatch(popup, /GPTWORK_UPDATE_INSTALL/);

  for (const source of [popup, options]) {
    assert.doesNotMatch(source, /connectNative\(/);
    assert.doesNotMatch(source, /chrome\.downloads\.download/);
    assert.doesNotMatch(source, /prepare_update/);
    assert.doesNotMatch(source, /chrome\.runtime\.reload\(/);
  }
  assert.match(updater, /function handleUpdateMessage/);
  assert.match(updater, /nativeRequest\('prepare_update'/);
});

test('generic background router delegates updater-owned runtime messages', () => {
  assert.match(background, /const UPDATE_MESSAGE_TYPES = new Set/);
  for (const type of ['GPTWORK_UPDATE_STATUS_GET', 'GPTWORK_UPDATE_CHECK', 'GPTWORK_UPDATE_INSTALL']) {
    assert.match(background, new RegExp(type));
  }
  assert.match(background, /TAB_FEATURE_MESSAGE_TYPES\.has\(message\.type\) \|\| UPDATE_MESSAGE_TYPES\.has\(message\.type\)/);
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
