import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const optionsSource = await readFile(new URL('../options.js', import.meta.url), 'utf8');
const featureController = await readFile(new URL('../feature-toggle-controller.js', import.meta.url), 'utf8');
const settingsHtml = await readFile(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');

test('settings page no longer depends on a bottom Save & sync action', () => {
  assert.doesNotMatch(settingsHtml, /id="save"/);
  assert.doesNotMatch(settingsHtml, /保存并同步\s*\/\s*Save &amp; sync/);
  assert.match(settingsHtml, /Work 模式和模型锁定按 ChatGPT 窗口隔离/);
  assert.match(settingsHtml, /同一窗口内的标签页共享状态/);
  assert.match(settingsHtml, /模型列表及其余配置继续同步/);
});

test('custom model button is Add-only and custom models are rendered in the choice list', () => {
  assert.match(settingsHtml, /id="saveCustomModels"[^>]*>添加 \/ Add<\/button>/);
  assert.match(optionsSource, /function renderCustomChoice\(/);
  assert.match(optionsSource, /renderCustomChoice\(model, true\)/);
  assert.match(optionsSource, /persistModelSelection/);
});

test('window feature gates use runtime authority while remaining settings use immediate patch writes', () => {
  assert.match(featureController, /GPTWORK_TAB_FEATURE_SET/);
  assert.match(featureController, /const targetTabId = currentTabId/);
  assert.match(featureController, /tabId:\s*targetTabId/);
  assert.match(featureController, /feature:\s*kind/);
  assert.doesNotMatch(featureController, /requireActivation\(/);
  assert.doesNotMatch(featureController, /GPTLOCK_SET_ENABLED/);
  assert.doesNotMatch(featureController, /chrome\.storage\.local\.set/);
  assert.match(optionsSource, /document\.addEventListener\('change', persistFromChange\)/);
  assert.match(optionsSource, /patchSettings\(\{ networkVerificationEnabled: target\.checked \}\)/);
  assert.match(optionsSource, /patchSettings\(\{ autoAlignSelection: target\.checked \}\)/);
  assert.match(optionsSource, /patchSettings\(\{ preferredReasoning \}\)/);
  assert.match(optionsSource, /patchPolicy\(\{ strictMode \}\)/);
  assert.match(optionsSource, /persistModelSelection/);
  assert.match(optionsSource, /persistReasoningSelection/);
});

test('settings writes merge from the latest stored object instead of stale page snapshots', () => {
  assert.match(optionsSource, /const current = normalizeSettings\(stored\.settings\)/);
  assert.match(optionsSource, /const next = normalizeSettings\(\{ \.\.\.current, \.\.\.patch \}\)/);
  assert.match(optionsSource, /const current = normalizePolicy\(stored\.policy\)/);
  assert.match(optionsSource, /const next = normalizePolicy\(\{ \.\.\.current, \.\.\.patch \}\)/);
});

test('a stale blocking content listener fails open when the extension runtime disappears', () => {
  assert.match(contentSource, /function runtimeContextAvailable\(/);
  assert.match(contentSource, /function failOpenStaleRuntime\(/);
  assert.match(contentSource, /if \(!guard\) return true/);
  assert.match(contentSource, /BLOCKING_GUARD_MAX_AGE_MS/);
  assert.match(contentSource, /GPTLOCK_GET_STATE/);
  assert.match(contentSource, /catch\(\(\) => failOpenStaleRuntime\(\)\)/);
});
