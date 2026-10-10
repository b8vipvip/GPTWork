// Regression: shared-conversation lock proof was replaced by isolated Chat attempts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const start = background.indexOf('async function verifyAccountCatalogModels');
const end = background.indexOf('function modelVerificationHistoryRecord', start);
const body = background.slice(start, end);

test('each Chat-lock model gets a fresh Chat document and reset evidence', () => {
  const from = background.indexOf('async function prepareSharedChatLockVerificationSurface');
  const to = background.indexOf('async function pinSharedChatLockConversation', from);
  const prepare = background.slice(from, to);
  assert.ok(from >= 0 && to > from);
  assert.equal((prepare.match(/chrome\.tabs\.update\(tabId, \{ url: 'https:\/\/chatgpt\.com\/' \}\)/g) || []).length, 1);
  assert.match(prepare, /sharedSession\.prepared = false/);
  assert.match(prepare, /resetVerificationAttempt\(liveState\)/);
  assert.match(prepare, /enableResponseCapture\(tabId\)/);
  assert.doesNotMatch(prepare, /if \(firstUse\)/);
  assert.match(body, /transactionStartedAtMs = Date\.now\(\)/);
});

test('picker A native baseline prevents no-effect Chat lock from claiming success', () => {
  assert.match(body, /chat_lock_distinct_picker_a_baseline_unavailable/);
  assert.match(body, /chat_lock_baseline_request_mismatch/);
  assert.match(body, /const effectiveRewrite = liveState\.lastRewrite\?\.changed === true\s*&& baselineConfirmed/);
  assert.match(body, /requestId\s*&& liveState\.lastRewrite\?\.requestId === requestId/);
  assert.match(body, /rawResponseProtocolModel === expectedResponse/);
  assert.match(body, /chatLockSupported: chatCompatibility \? verified : false/);
});

test('response mismatch and transport interruption are recorded separately', () => {
  assert.match(body, /picker_a_chat_lock_response_mismatch/);
  assert.match(body, /chat_lock_response_interrupted/);
  assert.match(body, /responseNetworkError: result\.responseNetworkError/);
  assert.match(body, /responseConfirmed = Boolean\(responseObserved && explicitResponseCompatible\)/);
});
