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

test('extension pages cross one runtime-generation barrier before feature/master commands', () => {
  assert.match(files['runtime-generation.js'], /RUNTIME_GENERATION_KEY = 'gptworkRuntimeGeneration'/);
  assert.match(files['background-entry.js'], /markRuntimeGeneration/);
  assert.match(files['extension-page-runtime.js'], /chrome\.runtime\.reload\(\)/);
  assert.match(files['extension-page-runtime.js'], /runtimeMessage\(payload\)/);
  assert.match(files['master-ui-controller.js'], /extension-page-runtime\.js/);
  assert.match(files['feature-toggle-controller.js'], /extension-page-runtime\.js/);
});
