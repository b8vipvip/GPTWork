import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = Object.fromEntries(await Promise.all([
  'background.js',
  'popup.js',
  'master-ui-controller.js',
  'tab-feature-runtime.js',
  'feature-toggle-controller.js',
  'extension-page-runtime.js',
  'runtime-generation.js',
  'background-entry.js',
].map(async (name) => [name, await readFile(new URL(`../${name}`, import.meta.url), 'utf8')])));

test('master and per-tab feature state have explicit non-overlapping owners', () => {
  assert.match(files['master-ui-controller.js'], /GPTWORK_MASTER_SET/);
  assert.match(files['tab-feature-runtime.js'], /GPTWORK_MASTER_SET/);
  assert.match(files['tab-feature-runtime.js'], /GPTWORK_TAB_FEATURE_SET/);
  assert.match(files['tab-feature-runtime.js'], /TAB_FEATURE_SESSION_KEY = 'gptworkTabFeatureStatesV2'/);
  assert.match(files['tab-feature-runtime.js'], /chrome\.storage\.session/);
  assert.doesNotMatch(files['tab-feature-runtime.js'], /states\.set\(windowId, next\)/);

  assert.doesNotMatch(files['popup.js'], /GPTLOCK_SET_ENABLED|GPTWORK_MASTER_SET/);
  assert.doesNotMatch(files['background.js'], /GPTLOCK_SET_ENABLED/);
  assert.match(files['background.js'], /TAB_FEATURE_MESSAGE_TYPES/);
  assert.match(files['background.js'], /effectivePolicyForTabSync/);
  assert.match(files['feature-toggle-controller.js'], /exact tabId, never windowId/);

  for (const source of Object.values(files)) {
    assert.doesNotMatch(source, /chrome\.runtime\.sendMessage\s*=/);
    assert.doesNotMatch(source, /chrome\.runtime\.onMessage\.addListener\s*=/);
    assert.doesNotMatch(source, /ChatGptNetworkMonitor\.prototype/);
  }
  assert.doesNotMatch(files['background-entry.js'], /master-runtime-safety|tab-feature-network-policy|network-monitor-safety/);
});

test('extension pages verify the actual service-worker generation before feature/master commands', () => {
  assert.match(files['runtime-generation.js'], /RUNTIME_GENERATION_MESSAGE = 'GPTWORK_RUNTIME_GENERATION_GET'/);
  assert.match(files['runtime-generation.js'], /ServiceWorkerGlobalScope/);
  assert.match(files['runtime-generation.js'], /sendResponse\(\{ ok: true, data: \{ generation: RUNTIME_GENERATION \} \}\)/);
  assert.doesNotMatch(files['runtime-generation.js'], /chrome\.storage/);

  assert.match(files['background-entry.js'], /^import '\.\/runtime-generation\.js';/);
  assert.doesNotMatch(files['background-entry.js'], /markRuntimeGeneration|RUNTIME_GENERATION_KEY/);

  assert.match(files['extension-page-runtime.js'], /requestWorkerGeneration\(\)/);
  assert.match(files['extension-page-runtime.js'], /chrome\.runtime\.sendMessage\(\{ type: RUNTIME_GENERATION_MESSAGE \}/);
  assert.match(files['extension-page-runtime.js'], /workerGeneration === RUNTIME_GENERATION/);
  assert.match(files['extension-page-runtime.js'], /chrome\.runtime\.reload\(\)/);
  assert.match(files['extension-page-runtime.js'], /return never\(\)/);
  assert.doesNotMatch(files['extension-page-runtime.js'], /chrome\.storage/);

  assert.ok(
    files['extension-page-runtime.js'].indexOf('await ensureRuntimeGeneration();')
      < files['extension-page-runtime.js'].indexOf('chrome.runtime.sendMessage(payload'),
    'business messages must cross the generation barrier first',
  );
  assert.match(files['master-ui-controller.js'], /extension-page-runtime\.js/);
  assert.match(files['feature-toggle-controller.js'], /extension-page-runtime\.js/);
});
