import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createVerificationCatalog } from '../vendor/modelpro/model-verification.js';

const normalizeModel = (value) => String(value || '').trim().toLowerCase() || null;
const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('v0.5.172 never downgrades a real Picker locator to a shared network candidate', () => {
  const catalog = createVerificationCatalog({ normalizeModel });
  catalog.merge({
    pickerMode: 'A',
    rows: [{
      model: 'gpt-5.5',
      rawId: 'gpt-5.5',
      label: 'GPT-5.5 · retiring',
      selectorKey: 'gpt-5.5 retiring',
      pickerMode: 'A',
    }],
  }, 'initial');
  catalog.merge({
    rows: [{
      model: 'gpt-5.5',
      rawId: 'gpt-5.5',
      label: 'gpt-5.5',
      selectorKey: '__network_candidate__',
      discoverySource: 'shared-server',
    }],
  }, 'shared-network-candidates');

  assert.equal(catalog.queue.length, 1);
  assert.equal(catalog.queue[0].selectorKey, 'gpt-5.5 retiring');
  assert.equal(catalog.queue[0].pickerMode, 'A');
  assert.equal(catalog.queue[0].label, 'GPT-5.5 · retiring');
});

test('v0.5.172 upgrades a network-only candidate when a real Picker locator arrives later', () => {
  const catalog = createVerificationCatalog({ normalizeModel });
  catalog.merge({
    rows: [{
      model: 'gpt-5.5',
      rawId: 'gpt-5.5',
      label: 'gpt-5.5',
      selectorKey: '__network_candidate__',
      discoverySource: 'shared-server',
    }],
  }, 'shared-network-candidates');
  catalog.merge({
    pickerMode: 'A',
    rows: [{
      model: 'gpt-5.5',
      rawId: 'gpt-5.5',
      label: 'GPT-5.5 · retiring',
      selectorKey: 'gpt-5.5 retiring',
      pickerMode: 'A',
    }],
  }, 'post-turn');

  assert.equal(catalog.queue.length, 1);
  assert.equal(catalog.queue[0].selectorKey, 'gpt-5.5 retiring');
  assert.equal(catalog.queue[0].pickerMode, 'A');
});

test('v0.5.172 Work transport outranks a generic network candidate when no real Picker exists', () => {
  const catalog = createVerificationCatalog({ normalizeModel });
  catalog.merge({
    rows: [{ model: 'gpt-6-astra', selectorKey: '__network_candidate__', label: 'GPT-6 Astra' }],
  }, 'shared-network-candidates');
  catalog.merge({
    rows: [{ model: 'gpt-6-astra', selectorKey: '__work_transport__', label: 'Work Default · gpt-6-astra' }],
  }, 'work-network');

  assert.equal(catalog.queue.length, 1);
  assert.equal(catalog.queue[0].selectorKey, '__work_transport__');
});

test('v0.5.172 Picker-B discovery owns an isolated pristine tab and never mutates the verification conversation', async () => {
  const background = await read('background.js');
  const controller = await read('work-mode-controller.js');

  assert.match(background, /chrome\.tabs\.create\(\{[\s\S]*url: 'https:\/\/chatgpt\.com\/'[\s\S]*active: false/);
  assert.match(background, /waitForNativeDiscoverySurface\(discoveryTabId, 9000\)/);
  assert.match(background, /discoverAccountCatalog\(discoveryTabId\)/);
  assert.match(background, /sendVerificationReasoningProbe\([\s\S]*discoveryTabId/);
  assert.match(background, /chrome\.tabs\.remove\(discoveryTabId\)/);
  assert.match(background, /native_work_catalog_discovery_temp_tab_closed/);
  assert.doesNotMatch(background, /sendTabMessage\(sourceTabId, \{ type: 'GPTWORK_DISCOVERY_ENTER_NATIVE_WORK'/);

  assert.match(controller, /GPTWORK_DISCOVERY_STATUS/);
  assert.match(controller, /ready: pristine && Boolean\(work\)/);
  assert.match(controller, /reason: !pristine \? 'not_pristine_new_chat'/);
  assert.doesNotMatch(controller, /GPTWORK_DISCOVERY_EXIT_NATIVE_WORK/);
});
