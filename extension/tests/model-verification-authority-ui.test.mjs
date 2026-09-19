import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const settings = await readFile(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const popup = await readFile(new URL('../popup-v0513.html', import.meta.url), 'utf8');
const historyUi = await readFile(new URL('../model-verification-history-options.js', import.meta.url), 'utf8');

test('model verification has one model-identity authority: the formal network request', () => {
  assert.match(content, /selectionAttempted/);
  assert.match(background, /sole authority for which model ChatGPT actually selected/);
  assert.match(background, /requestModel === item\.model/);
  assert.doesNotMatch(background, /Model selection was not confirmed/);
  assert.doesNotMatch(background, /function verificationOutcome/);
  assert.doesNotMatch(background, /function requestLockConfirmed/);
  assert.doesNotMatch(background, /function probeText/);
});

test('verification progress lives on the in-page GPTWork indicator and is removed when the run ends', () => {
  assert.match(content, /model-verification-progress/);
  assert.match(content, /root\.querySelector\('\.model-verification-progress'\)\?\.remove\(\)/);
  assert.doesNotMatch(popup, /id="autoVerifyProgress"/);
  assert.match(popup, />模型验证<\/button>/);
});

test('settings runtime card has no verification action and exposes persistent verification history', () => {
  const runtimeStart = settings.indexOf('id="statusHeading"');
  const historyStart = settings.indexOf('id="modelVerificationHistoryHeading"');
  const requestHistoryStart = settings.indexOf('id="requestHistoryHeading"');
  assert(runtimeStart >= 0);
  assert(historyStart > runtimeStart);
  assert(requestHistoryStart > historyStart);
  assert.doesNotMatch(settings.slice(runtimeStart, historyStart), /id="autoVerify"/);
  assert.match(settings, /模型验证记录/);
  assert.match(settings, /model-verification-history-options\.js/);
  assert.match(background, /modelVerificationHistoryV1/);
  assert.match(background, /persistModelVerificationHistory/);
  assert.match(historyUi, /chrome\.storage\.local\.get\(MODEL_VERIFICATION_HISTORY_KEY\)/);
});


test('model automation is composer-scoped and cannot use arbitrary sidebar menus', () => {
  assert.match(content, /composerRoot\.querySelectorAll\(selector\)/);
  assert.match(content, /Never scan arbitrary global menus/);
  assert.match(content, /verifiedModelRows/);
  assert.match(content, /dismissWorkContinuationPrompt/);
  assert.match(content, /留在聊天模式/);
});


test('model verification probe and progress stay visible and sidebar-safe', () => {
  assert.match(content, /There is deliberately no generic legacy fallback for model selection/);
  assert.match(content, /recent-chat "\.\.\." action menu/);
  assert.match(content, /await trustedPointer\(sendButton, 'click'\)/);
  assert.match(content, /\.indicator-shell\{display:flex;flex-direction:column/);
  assert.match(content, /\.model-verification-progress\{order:-1\}/);
  assert.match(background, /Request lock monitor did not reattach after model selection/);
});



test('v0.5.81 model automation has one composer-scoped authority', () => {
  assert.match(content, /Single authority: only an explicit ChatGPT composer intelligence\/model control/);
  assert.doesNotMatch(content, /const scored = candidates\.map/);
  assert.match(content, /if \(unique\.length !== 1\) return null/);
  assert.match(content, /menu\.getAttribute\?\.\('aria-labelledby'\) === openerId/);
  assert.match(content, /gptlock-verification-progress-host/);
  assert.match(content, /bottom:52px/);
});
