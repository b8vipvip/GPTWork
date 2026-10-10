import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const content = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

test('auto alignment does not probe generic ChatGPT menu/composer/form buttons', () => {
  assert.doesNotMatch(content, /\[role="banner"\] button\[aria-haspopup\]/);
  assert.doesNotMatch(content, /header button\[aria-haspopup\]/);
  assert.doesNotMatch(content, /\[data-testid\*="composer"\] button/);
  assert.doesNotMatch(content, /'form button'/);
});

test('unknown page model/reasoning values are never force-clicked', () => {
  assert.match(content, /desiredModel && observation\.model && observation\.model !== desiredModel/);
  assert.match(content, /preferred && !changed && afterModel\.reasoning && afterModel\.reasoning !== preferred/);
});

test('floating status is anchored bottom-right and broad role-button scan is observation-only', () => {
  assert.match(content, /position:fixed;right:12px;bottom:12px/);
  assert.match(content, /composerNearbyControls\(\)/);
  assert.doesNotMatch(content, /chooseExact\(\['button/);
});
