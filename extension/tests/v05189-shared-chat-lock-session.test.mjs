// [legacy-core-maintenance] v0.5.189 keeps Chat-lock discovery in one conversation and preserves strict backend truth.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('root navigation belongs only to first-use shared-session preparation', () => {
  const prepareStart = background.indexOf('async function prepareSharedChatLockVerificationSurface');
  const prepareEnd = background.indexOf('async function pinSharedChatLockConversation', prepareStart);
  const prepare = background.slice(prepareStart, prepareEnd);
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  assert.match(prepare, /const firstUse = sharedSession\?\.prepared !== true/);
  assert.match(prepare, /if \(firstUse\) \{/);
  assert.equal((prepare.match(/chrome\.tabs\.update\(tabId, \{ url: 'https:\/\/chatgpt\.com\/' \}\)/g) || []).length, 1);
  assert.match(prepare, /sharedSession\.prepared = true/);
  assert.match(prepare, /chat_lock_shared_session_reused/);
});

test('the verification loop passes the same shared session through Picker A and Picker B lock tasks', () => {
  const start = background.indexOf('async function verifyAccountCatalogModels');
  const end = background.indexOf('function modelVerificationHistoryRecord', start);
  const body = background.slice(start, end);
  assert.match(body, /const sharedChatLockSession = \{/);
  assert.match(body, /pickerAChatLock \|\| pickerBChatLock/);
  assert.match(body, /prepareSharedChatLockVerificationSurface\(tabId, ownerTabId, item, sharedChatLockSession\)/);
  assert.match(body, /pinSharedChatLockConversation\(tabId, ownerTabId, sharedChatLockSession, item\)/);
  assert.doesNotMatch(body, /chrome\.tabs\.update\(tabId, \{ url: 'https:\/\/chatgpt\.com\/' \}\)/);
});

test('backend response mismatch still fails instead of being promoted by the shared-session change', () => {
  const start = background.indexOf('async function verifyAccountCatalogModels');
  const end = background.indexOf('function modelVerificationHistoryRecord', start);
  const body = background.slice(start, end);
  assert.match(body, /rawResponseProtocolModel === expectedResponse/);
  assert.match(body, /responseConfirmed = Boolean\(responseObserved && explicitResponseCompatible\)/);
  assert.match(body, /picker_a_chat_lock_response_mismatch/);
  assert.match(body, /chat_mode_response_differs_from_official_work/);
  assert.match(body, /chatLockSupported: chatCompatibility \? verified : false/);
});
