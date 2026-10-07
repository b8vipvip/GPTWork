import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');

test('v0.5.179 verification surface probes the live content runtime before tab load completes', () => {
  const start = background.indexOf('async function waitForVerificationSurface');
  const end = background.indexOf('async function createVerificationExecutionTab', start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);

  assert.match(block, /last = await verificationSurfaceStatus\(tabId\)/);
  assert.doesNotMatch(block, /if \(tab\.status === 'complete'\) \{\s*last = await verificationSurfaceStatus/);
  assert.match(block, /ensureContentRuntime\(tabId, 'verification_surface_wait'\)/);
  assert.match(block, /recoveryAttempted/);
});

test('v0.5.179 directly recognizes the real ChatGPT Work submit button semantics', () => {
  assert.match(content, /button\[type="submit"\]\[aria-label="发送"\]/);
  assert.match(content, /button\[type="submit"\]\[aria-label="Send" i\]/);
  assert.match(content, /button\[data-testid="send-button"\]/);
});
