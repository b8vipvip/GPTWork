// [legacy-core-maintenance] v0.5.189 supersedes per-model fresh resets with one shared Chat-lock conversation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('Picker A and Picker B Chat-lock passes share one Chat tab and conversation', () => {
  assert.match(background, /async function prepareSharedChatLockVerificationSurface/);
  assert.match(background, /const firstUse = sharedSession\?\.prepared !== true/);
  assert.match(background, /if \(firstUse\)/);
  assert.match(background, /chrome\.tabs\.update\(tabId, \{ url: 'https:\/\/chatgpt\.com\/' \}\)/);
  assert.match(background, /chat_lock_shared_session_started/);
  assert.match(background, /chat_lock_shared_session_reused/);
  assert.match(background, /chat_lock_shared_conversation_pinned/);
  assert.match(background, /sharedSession\.conversationPathname/);
  assert.doesNotMatch(background, /resetChatLockVerificationSurface/);

  const verifyStart = background.indexOf('async function verifyAccountCatalogModels');
  const verifyEnd = background.indexOf('function modelVerificationHistoryRecord', verifyStart);
  const body = background.slice(verifyStart, verifyEnd);
  assert.match(body, /const sharedChatLockSession = \{/);
  const prepare = body.indexOf('await prepareSharedChatLockVerificationSurface(tabId, ownerTabId, item, sharedChatLockSession)');
  const probe = body.indexOf('const probe = await sendVerificationReasoningProbe', prepare);
  assert.ok(prepare >= 0);
  assert.ok(probe > prepare);
  assert.match(body, /await pinSharedChatLockConversation\(tabId, ownerTabId, sharedChatLockSession, item\)/);
});

test('shared Chat-lock attempts still restart evidence clocks and use the live post-attempt state', () => {
  const verifyStart = background.indexOf('async function verifyAccountCatalogModels');
  const verifyEnd = background.indexOf('function modelVerificationHistoryRecord', verifyStart);
  const body = background.slice(verifyStart, verifyEnd);
  assert.match(body, /transactionStartedAtMs = Date\.now\(\);/);
  assert.match(body, /transaction\.startedAt = transactionStartedAtMs/);
  assert.match(body, /const liveState = ensureTabState\(tabId\)/);
  assert.match(body, /liveState\.lastRewrite\?\.transportModelAfter/);
  assert.match(body, /liveState\.lastRewrite\?\.authorityKind === 'model-discovery-chat-compat'/);
});

test('discovery response evidence bypasses ordinary lock-policy verdict mutation', () => {
  const applyStart = background.indexOf('async function applyNetworkEvidence');
  const applyEnd = background.indexOf('const networkMonitor = new ChatGptNetworkMonitor', applyStart);
  const body = background.slice(applyStart, applyEnd);
  const transaction = body.indexOf('const discoveryTransaction = verificationTransactionForTab(tabId)');
  const observed = body.indexOf("'verification_response_evidence_observed'");
  const ordinaryVerify = body.indexOf('const result = await verifyObservation');
  assert.ok(transaction >= 0);
  assert.ok(observed > transaction);
  assert.ok(ordinaryVerify > observed);
  assert.match(body, /if \(discoveryTransaction\?\.model\)/);
  assert.match(body, /await broadcastTabState\(tabId\);\s*return;/);
});
