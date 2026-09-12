import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = Object.fromEntries(await Promise.all([
  'background.js',
  'popup.js',
  'master-ui-controller.js',
  'tab-feature-runtime.js',
  'background-entry.js',
].map(async (name) => [name, await readFile(new URL(`../${name}`, import.meta.url), 'utf8')])));

test('master and per-tab state have single explicit owners', () => {
  assert.match(files['master-ui-controller.js'], /GPTWORK_MASTER_SET/);
  assert.match(files['tab-feature-runtime.js'], /GPTWORK_MASTER_SET/);
  assert.match(files['tab-feature-runtime.js'], /GPTWORK_TAB_FEATURE_SET/);
  assert.match(files['tab-feature-runtime.js'], /chrome\.storage\.session/);

  assert.doesNotMatch(files['popup.js'], /GPTLOCK_SET_ENABLED|GPTWORK_MASTER_SET/);
  assert.doesNotMatch(files['background.js'], /GPTLOCK_SET_ENABLED/);
  assert.match(files['background.js'], /TAB_FEATURE_MESSAGE_TYPES/);
  assert.match(files['background.js'], /effectivePolicyForTabSync/);

  for (const source of Object.values(files)) {
    assert.doesNotMatch(source, /chrome\.runtime\.sendMessage\s*=/);
    assert.doesNotMatch(source, /chrome\.runtime\.onMessage\.addListener\s*=/);
    assert.doesNotMatch(source, /ChatGptNetworkMonitor\.prototype/);
  }
  assert.doesNotMatch(files['background-entry.js'], /tab-feature-network-policy|network-monitor-safety/);
});
