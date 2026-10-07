import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const compat = await readFile(new URL('../composer-send-compat.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const monitor = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');

test('v0.5.178 never treats project/dialog controls as a send button', () => {
  assert.match(compat, /const popup = String\(button\.getAttribute\('aria-haspopup'\)/);
  assert.match(compat, /popup && popup !== 'false'/);
  assert.match(compat, /选择项目/);
  assert.match(compat, /trailingBoundary/);
  assert.match(content, /const popup = String\(element\.getAttribute\?\.\('aria-haspopup'\)/);
  assert.match(content, /if \(popup && popup !== 'false'\) return false/);
  assert.match(content, /选择项目/);
});

test('v0.5.178 uses a trusted Enter fallback instead of guessing another Work composer button', () => {
  assert.match(content, /async function trustedEnter/);
  assert.match(content, /type: 'GPTLOCK_TRUSTED_KEY'/);
  assert.match(content, /auto_probe_send_button_unavailable/);
  assert.match(content, /sendMethod = 'visible_composer_enter'/);
  assert.match(background, /case 'GPTLOCK_TRUSTED_KEY'/);
  assert.match(background, /key !== 'Enter'/);
  assert.match(background, /networkMonitor\.trustedKey\(sender\.tab\.id, key\)/);
  assert.match(monitor, /async trustedKey\(tabId, key = 'Enter'\)/);
  assert.match(monitor, /Input\.dispatchKeyEvent/);
  assert.match(monitor, /type: 'rawKeyDown'/);
  assert.match(monitor, /type: 'keyUp'/);
});
