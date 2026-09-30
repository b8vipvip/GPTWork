import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const monitor = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');

test('v0.5.157 Work bootstrap has one terminal request authority', () => {
  assert.doesNotMatch(background, /workBootstrapTabs/);
  assert.match(background, /beginWorkBootstrapTransaction\(tabId, 'picker-b-reacquire'\)/);
  assert.match(background, /endWorkBootstrapTransaction\(tabId, workBootstrap\.previous\)/);
  assert.match(background, /beginWorkBootstrapTransaction\(tabId, 'post-sol-work-activation'\)/);
  assert.match(background, /activationRewrite\?\.authorityKind === 'verification-transaction'/);
  assert.match(monitor, /authorityKind: 'verification-transaction'/);
  assert.match(monitor, /forceModel: model/);
});

test('nested Picker B bootstrap restores the catalog verification transaction', () => {
  const start = background.indexOf('async function reacquirePickerBForModel');
  const end = background.indexOf('async function verifyAccountCatalogModels', start);
  const block = background.slice(start, end);
  assert.match(block, /const workBootstrap = beginWorkBootstrapTransaction/);
  assert.match(block, /finally \{[\s\S]*endWorkBootstrapTransaction\(tabId, workBootstrap\.previous\)/);
});
