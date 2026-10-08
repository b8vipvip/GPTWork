import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const compat = await readFile(new URL('../composer-send-compat.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');

test('v0.5.177 never promotes desktop-app or Codex deeplink controls to the send button', () => {
  assert.match(compat, /NON_SEND_ACTION/);
  assert.match(compat, /打开桌面应用/);
  assert.match(compat, /desktop\\s\+app/);
  assert.match(compat, /deeplink/);
  assert.match(compat, /clearUnsafeCompatMarker/);
  assert.match(compat, /for \(const button of buttons\) clearUnsafeCompatMarker\(button\)/);

  assert.match(content, /NON_SEND_COMPOSER_ACTION/);
  assert.match(content, /function safeSendButton/);
  assert.match(content, /form && !form\.contains\(element\)/);
  assert.match(content, /打开桌面应用/);
  assert.match(content, /deeplink/);
  assert.match(content, /\.find\(\(element\) => safeSendButton\(element, composer\)\)/);
});

test('v0.5.177 confirms official Work from the live Work composer surface', () => {
  assert.match(content, /function verificationWorkSurfaceActive/);
  assert.match(content, /chatgpt\\s\*work/);
  assert.match(content, /使用\\s\*chatgpt\\s\*work/);
  assert.match(content, /const initial = verificationWorkSurfaceEvidence\(\)/);
  assert.match(content, /const current = verificationWorkSurfaceEvidence\(\)/);
  assert.match(content, /work_surface_confirmed/);
});
