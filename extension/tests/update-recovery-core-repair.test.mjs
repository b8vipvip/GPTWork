import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const updater = await readFile(new URL('../background-update.js', import.meta.url), 'utf8');
const popup = await readFile(new URL('../popup.js', import.meta.url), 'utf8');

test('manual reconnect waits for an in-flight initialization before retrying', () => {
  assert.match(background, /case 'GPTLOCK_RECONNECT':[\s\S]*await initializeAfterCurrentTask\(\)/);
});

test('post-update recovery explicitly reconnects through the background lifecycle authority', () => {
  assert.match(updater, /update_reconnect_after_reload_failed/);
  assert.match(updater, /initializeAfterCurrentTask\(\)/);
  assert.doesNotMatch(updater, /runtime\.sendMessage\(message/);
});

test('core repair checks an existing native install before opening the installer', () => {
  assert.match(updater, /GPTWORK_CORE_REPAIR/);
  assert.match(updater, /core_repair_existing_install_detected/);
  assert.match(popup, /sendMessage\(\{ type: 'GPTWORK_CORE_REPAIR' \}\)/);
  assert.match(popup, /if \(result\?\.installed\)/);
});
