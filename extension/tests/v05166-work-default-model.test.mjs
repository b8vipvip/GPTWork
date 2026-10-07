import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizePolicy } from '../policy.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('legacy policy defaults Work to GPT-6 Astra and accepts a configured locked model', () => {
  assert.equal(normalizePolicy({ lockedModels: ['gpt-6-sol'] }).workDefaultModel, 'gpt-6-astra');
  assert.equal(normalizePolicy({
    lockedModels: ['gpt-6-astra', 'gpt-6-sol'],
    workDefaultModel: 'gpt-6-sol',
  }).workDefaultModel, 'gpt-6-sol');
});

test('settings source derives Work default choices from locked models', async () => {
  const [html, options] = await Promise.all([read('settings-v0521.html'), read('options.js')]);
  assert.match(html, /id="workDefaultModel"/);
  assert.match(options, /policy\.lockedModels\.map\(normalizeConcreteModelId\)/);
  assert.match(options, /patchPolicy\(\{ workDefaultModel: target\.value \}\)/);
});

test('request policy and verification both consume the configured Work default', async () => {
  const [runtime, background] = await Promise.all([read('tab-feature-runtime.js'), read('background.js')]);
  assert.match(runtime, /basePolicy\.workDefaultModel/);
  assert.match(runtime, /isAtLeastWorkFloor\(selected, floor\) \? selected : floor/);
  assert.match(background, /const workDefaultModel = workBootstrapModelForTab\(tabId\)/);
  assert.match(background, /function workBootstrapModelForTab\(tabId\) \{\s*const policy = effectivePolicyForTabSync\(tabId\);\s*return normalizeConcreteModelId\(policy\.workDefaultModel\)/);
  assert.match(background, /selectorKey: '__work_transport__'/);
  assert.doesNotMatch(background.slice(
    background.indexOf('async function verifyAccountCatalogModels'),
    background.indexOf('function modelVerificationHistoryRecord'),
  ), /model: 'gpt-6-astra'/);
});

test('content indicator exposes the active Work strategy', async () => {
  const controller = await read('work-mode-controller.js');
  assert.match(controller, /data-source="work-strategy"/);
  assert.match(controller, /Work策略/);
  assert.match(controller, /message\.policy\?\.workDefaultModel/);
});
