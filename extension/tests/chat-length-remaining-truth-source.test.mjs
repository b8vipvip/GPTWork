import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const scripts = manifest.content_scripts?.[0]?.js || [];
const recovery = await readFile(new URL('../content-runtime-recovery.js', import.meta.url), 'utf8');
const semantic = await readFile(new URL('../chat-length-hard-limit-semantic.js', import.meta.url), 'utf8');

test('v0.5.49 chat-length truth observer is not auto-loaded on every ChatGPT page', () => {
  assert.ok(scripts.includes('chat-length-remaining-indicator.js'));
  assert.equal(scripts.includes('chat-length-remaining-truth.js'), false);
  assert.doesNotMatch(recovery, /['"]chat-length-remaining-truth\.js['"]/);
});

test('hard-limit semantic bridge keeps the v0.5.48 bounded selector strategy', () => {
  assert.match(semantic, /querySelectorAll\(`p,\[role="alert"\],\[role="status"\],\[\$\{MARKER\}\]`\)/);
  assert.doesNotMatch(semantic, /querySelectorAll\(['"]button,a['"]\)/);
  assert.doesNotMatch(semantic, /HARD_LIMIT_ACTION_PATTERN/);
});
