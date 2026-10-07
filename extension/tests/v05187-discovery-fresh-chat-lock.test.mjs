// [legacy-core-maintenance] v0.5.187 discovery isolation from runtime lock policy.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('Picker A and Picker B Chat-lock passes reset onto a fresh Chat surface first', () => {
  assert.match(background, /async function resetChatLockVerificationSurface/);
  assert.match(background, /chrome\.tabs\.update\(tabId, \{ url: 'https:\/\/chatgpt\.com\/' \}\)/);
  assert.match(background, /waitForVerificationSurface\(tabId, 12000, \{ requireVisible: true \}\)/);
  assert.match(background, /chat_lock_surface_reset_started/);
  assert.match(background, /chat_lock_surface_reset_completed/);

  const verifyStart = background.indexOf('async function verifyAccountCatalogModels');
  const verifyEnd = background.indexOf('function modelVerificationHistoryRecord', verifyStart);
  const body = background.slice(verifyStart, verifyEnd);
  const reset = body.indexOf('await resetChatLockVerificationSurface(tabId, ownerTabId, item)');
  const probe = body.indexOf('const probe = await sendVerificationReasoningProbe', reset);
  assert.ok(reset >= 0);
  assert.ok(probe > reset);
  assert.match(body, /if \(chatCompatibility\)/);
});

test('fresh Chat-lock pass restarts its evidence clock and reads the post-navigation live state', () => {
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
