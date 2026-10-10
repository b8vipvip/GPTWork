// Regression: each Picker A Chat-lock proof starts in its own new Chat session.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const verifyStart = background.indexOf('async function verifyAccountCatalogModels');
const verifyEnd = background.indexOf('function modelVerificationHistoryRecord', verifyStart);
const body = background.slice(verifyStart, verifyEnd);

test('a fresh ordinary Chat surface is required for every Picker A lock attempt', () => {
  const start = background.indexOf('async function prepareSharedChatLockVerificationSurface');
  const end = background.indexOf('async function pinSharedChatLockConversation', start);
  const prepare = background.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(prepare, /sharedSession\.prepared = false/);
  assert.match(prepare, /sharedSession\.conversationPathname = null/);
  assert.match(prepare, /chrome\.tabs\.update\(tabId, \{ url: 'https:\/\/chatgpt\.com\/' \}\)/);
  assert.match(prepare, /chat_lock_isolated_session_ready/);
  assert.match(prepare, /requireVerificationOfficialChatMode\(tabId, item, \{ switchIfNeeded: true \}\)/);
  assert.doesNotMatch(prepare, /chat_lock_shared_session_reused/);
  assert.match(body, /await prepareSharedChatLockVerificationSurface\(tabId, ownerTabId, item, sharedChatLockSession\)/);
  assert.doesNotMatch(body, /await pinSharedChatLockConversation\(/);
});

test('distinct native Picker A selection precedes the forced Chat request', () => {
  const prepare = body.indexOf('await prepareSharedChatLockVerificationSurface(');
  const choose = body.indexOf("type: 'GPTLOCK_VERIFY_ACCOUNT_MODEL'", prepare);
  const probe = body.indexOf('const probe = await sendVerificationReasoningProbe', prepare);
  assert.ok(prepare >= 0 && choose > prepare && probe > choose);
  assert.match(body, /baselineSelectionAttempted = selected\?\.result\?\.selectionAttempted === true/);
  assert.match(body, /const baselineConfirmed = Boolean\(/);
  assert.match(body, /observedBaselineTransport === baselineTransport/);
  assert.match(body, /observedBaselineTransport !== expectedTransport/);
  assert.match(body, /liveState\.lastRewrite\?\.requestId === requestId/);
  assert.match(body, /liveState\.lastRequest\?\.requestId === requestId/);
});

test('discovery response truth bypasses ordinary lock-policy verdict mutation', () => {
  const applyStart = background.indexOf('async function applyNetworkEvidence');
  const applyEnd = background.indexOf('const networkMonitor = new ChatGptNetworkMonitor', applyStart);
  const value = background.slice(applyStart, applyEnd);
  const transaction = value.indexOf('const discoveryTransaction = verificationTransactionForTab(tabId)');
  const observed = value.indexOf("'verification_response_evidence_observed'");
  const ordinaryVerify = value.indexOf('const result = await verifyObservation');
  assert.ok(transaction >= 0 && observed > transaction && ordinaryVerify > observed);
  assert.match(value, /if \(discoveryTransaction\?\.model\)/);
});
