// Runtime regression: v0.5.182 Work Picker-B requests were real, but URL migration left the verifier reading a stale state object.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const popup = await readFile(new URL('../popup.js', import.meta.url), 'utf8');

test('v0.5.183 preserves a tab state while any model-verification transaction owns the tab', () => {
  const start = background.indexOf('function ensureTabState');
  const end = background.indexOf('function accountAllowsState', start);
  assert.ok(start >= 0 && end > start);
  const body = background.slice(start, end);
  assert.match(body, /verificationTransactionForTab\(tabId\)/);
  assert.match(body, /auto_verify_context_migrated/);
});

test('v0.5.183 Work verification reads the live state after SPA conversation navigation', () => {
  const start = background.indexOf('async function discoverOfficialWorkModels');
  const end = background.indexOf('async function publishAccountModels', start);
  assert.ok(start >= 0 && end > start);
  const body = background.slice(start, end);
  assert.match(body, /const liveState = ensureTabState\(discoveryTabId\)/);
  assert.match(body, /liveState\.lastRewrite\?\.transportModelAfter/);
  assert.match(body, /liveState\.lastRequest\?\.rawModel/);
  assert.match(body, /nativeRequestConfirmed = Boolean\(rawRequestModel\)/);
});

test('v0.5.183 mirrors the running discovery state onto the active official Work tab', () => {
  const start = background.indexOf('async function discoverOfficialWorkModels');
  const end = background.indexOf('async function publishAccountModels', start);
  const body = background.slice(start, end);
  assert.match(body, /discoveryState\.autoVerification = sourceState\.autoVerification/);
  assert.match(body, /activeStage = \{[\s\S]*id: 'picker-b-work'/);
  assert.match(body, /broadcastVerificationState\(sourceTabId, ownerTabId, \[discoveryTabId\]\)/);
  assert.match(body, /completed: index \+ 1/);
  assert.match(body, /requestConfirmed: nativeResults\.filter\(\(item\) => item\.nativeRequestConfirmed\)\.length/);
});

test('v0.5.183 excludes the redesigned Select-model ViewTrack opener from concrete model rows', () => {
  const start = content.indexOf('function verifiedModelRows');
  const end = content.indexOf('function distinctModelRows', start);
  const body = content.slice(start, end);
  assert.match(body, /accessibleName/);
  assert.match(body, /select model\|choose model\|选择模型/);
  assert.match(body, /return false/);
});

test('v0.5.183 page and popup progress render Picker-B Work active-stage metrics', () => {
  const indicatorStart = content.indexOf('function renderIndicator');
  const indicatorEnd = content.indexOf('function showNotice', indicatorStart);
  const indicator = content.slice(indicatorStart, indicatorEnd);
  assert.match(indicator, /catalog\?\.activeStage/);
  assert.match(indicator, /activeStage\?\.completed/);
  assert.match(indicator, /activeStage\?\.requestConfirmed/);
  assert.match(indicator, /Picker B/);

  const popupStart = popup.indexOf('function renderAutoVerifyProgress');
  const popupEnd = popup.indexOf('function showAutoVerifyToast', popupStart);
  const popupBody = popup.slice(popupStart, popupEnd);
  assert.match(popupBody, /catalog\?\.activeStage/);
  assert.match(popupBody, /activeStage\?\.completed/);
  assert.match(popupBody, /stageLabel/);
});
