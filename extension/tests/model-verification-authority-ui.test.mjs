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
  assert.match(background, /probeMarker: 'GPTWork 模型验证'/);
  assert.doesNotMatch(background, /Model selection was not confirmed/);
});

test('verification progress is a separate fixed host above the status indicator', () => {
  assert.match(content, /gptlock-verification-progress-host/);
  assert.match(content, /position:fixed;right:12px;bottom:52px/);
  assert.match(content, /document\.getElementById\('gptlock-verification-progress-host'\)\?\.remove\(\)/);
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


test('model automation is composer-scoped and structurally owned', () => {
  assert.match(content, /function activeComposerSurface/);
  assert.match(content, /Single authority: only an explicit ChatGPT composer intelligence\/model control/);
  assert.doesNotMatch(content, /const scored = candidates\.map/);
  assert.match(content, /if \(unique\.length !== 1\) return null/);
  assert.match(content, /menu\.getAttribute\?\.\('aria-labelledby'\) === openerId/);
  assert.match(content, /verifiedModelRows/);
  assert.match(content, /dismissWorkContinuationPrompt/);
  assert.match(content, /留在聊天模式/);
});

test('model verification probe uses trusted send and monitor reattach', () => {
  assert.match(content, /await trustedPointer\(sendButton, 'click', 'auto-probe-send'\)/);
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


test('v0.5.82 follows the causal three-stage ChatGPT model picker', () => {
  assert.match(content, /function distinctModelRows/);
  assert.match(content, /function isModelListScope/);
  assert.match(content, /const beforeScopes = new Set\(modelPopupScopes\(\)\)/);
  assert.match(content, /await trustedPointer\(opener, 'click', 'model-picker-submenu'\)/);
  assert.match(content, /Single ownership chain: the final model list/);
  assert.doesNotMatch(content, /await trustedPointer\(opener, 'move'\)/);
  assert.match(content, /rows\.length < 2/);
});

test('verification progress is placed above both GPTWork floating surfaces', () => {
  assert.match(content, /function positionVerificationProgressHost/);
  assert.match(content, /'gptlock-model-indicator-host', 'gptlock-indicator-host'/);
  assert.match(content, /window\.innerHeight - top \+ 8/);
  assert.match(content, /positionVerificationProgressHost\(progressHost\)/);
});


test('v0.5.83 has one model UI transaction authority and never clicks from observation', () => {
  assert.match(content, /cachedState\?\.autoVerification\?\.running/);
  assert.match(content, /DOM observation never performs clicks/);
  assert.doesNotMatch(content, /mutations\.some[\s\S]{0,180}dismissWorkContinuationPrompt/);
  assert.doesNotMatch(content, /ensureIndicator\(\);\s*void dismissWorkContinuationPrompt/);
  assert.doesNotMatch(content, /if \(isModelListScope\(picker\)\)/);
  assert.match(content, /Single ownership chain: the final model list/);
});

test('trusted pointer attaches first and revalidates the exact DOM target after layout settles', () => {
  assert.match(content, /GPTLOCK_TRUSTED_POINTER_PREPARE/);
  assert.match(content, /requestAnimationFrame\(\(\) => requestAnimationFrame\(resolve\)\)/);
  assert.match(content, /function pointerStillOwnsPoint/);
  assert.match(content, /document\.elementFromPoint/);
  assert.match(background, /case 'GPTLOCK_TRUSTED_POINTER_PREPARE'/);
});

test('verification request-lock mode is owned by an explicit transaction, not migrated tab UI state', () => {
  assert.match(background, /const verificationTransactions = new Map\(\)/);
  assert.match(background, /function verificationTransactionForTab/);
  assert.match(background, /verificationTransactions\.set\(Number\(tabId\)/);
  assert.match(background, /verificationTransactions\.delete\(Number\(tabId\)/);
  assert.match(background, /preserveModel: Boolean\(transaction\)/);
  assert.doesNotMatch(background, /function autoVerificationSelectionActiveForTab/);
  assert.doesNotMatch(background, /function autoVerificationModelForTab/);
});
