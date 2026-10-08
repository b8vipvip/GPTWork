// legacy-core-maintenance synchronized after PR label is present.
// v0.5.184 regression: lock-model choices are server four-gate models only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [background, content, popup, catalogOptions, verificationPolicy, server] = await Promise.all([
  read('background.js'),
  read('content.js'),
  read('popup.js'),
  read('model-catalog-options.js'),
  read('vendor/modelpro/model-verification.js'),
  read('../license-server/account-system-base.mjs'),
]);

test('v0.5.184 server client catalog requires all four gates on the same account', () => {
  assert.match(server, /clientEligibleOnly = false/);
  assert.match(server, /eligible\.request_confirmed=1/);
  assert.match(server, /eligible\.response_confirmed=1/);
  assert.match(server, /eligible\.chat_lock_request_confirmed=1/);
  assert.match(server, /eligible\.chat_lock_response_confirmed=1/);
  assert.match(server, /sharedModelCatalog\(\{ clientEligibleOnly: true \}\)/);
  assert.match(server, /clientEligibleAccountCount/);
});

test('v0.5.184 client sync prunes stale locks and runs after login plus once per runtime version', () => {
  assert.match(background, /function sharedModelClientEligible/);
  assert.match(background, /function normalizeClientSharedModels/);
  assert.match(background, /async function applyClientSharedModelCatalog/);
  assert.match(background, /policy\.lockedModels\.filter\(\(model\) => allowed\.has\(model\)\)/);
  assert.match(background, /sharedModelProtocolMap = new Map\(models[\s\S]*transport: item\.chatTransportModel/);
  assert.match(background, /shared_model_catalog_login_sync_completed/);
  assert.match(background, /syncSharedKnownModelsAfterRuntimeUpdate\(manifestVersion\)/);
  assert.match(background, /SHARED_MODEL_CATALOG_SYNC_VERSION_KEY/);
});

test('v0.5.184 lock model UI is sourced only from the synchronized shared catalog', () => {
  const popupIdsStart = popup.indexOf('function popupModelIds');
  const popupIdsEnd = popup.indexOf('function renderPopupLockEditor', popupIdsStart);
  const popupIds = popup.slice(popupIdsStart, popupIdsEnd);
  assert.match(popupIds, /gptworkSharedKnownModelsV1/);
  assert.doesNotMatch(popupIds, /KNOWN_MODELS/);
  assert.doesNotMatch(popupIds, /discoveredModels/);
  assert.doesNotMatch(popupIds, /policy\.lockedModels/);

  const refreshStart = catalogOptions.indexOf('async function refresh');
  const refreshEnd = catalogOptions.indexOf('chrome.storage.onChanged', refreshStart);
  const refresh = catalogOptions.slice(refreshStart, refreshEnd);
  assert.match(refresh, /sharedIds/);
  assert.match(refresh, /lockedBefore[\s\S]*sharedIds\.has\(model\)/);
  assert.match(refresh, /appendSharedChoice/);
  assert.match(refresh, /enforceSharedOnlyChoices/);
  assert.doesNotMatch(refresh, /appendChoice\(model/);
  assert.match(catalogOptions, /Server shared catalog · 4\/4 verified/);
});

test('v0.5.184 Picker A and Picker B both get a distinct forced Chat-lock pass', () => {
  assert.match(background, /selectorKey: '__picker_a_chat_lock__'/);
  assert.match(background, /selectorKey: '__picker_b_chat_lock__'/);
  assert.match(background, /picker_a_chat_lock_queued/);
  assert.match(background, /pickerAChatLock \|\| pickerBChatLock/);
  assert.match(background, /chatLockSupported: chatCompatibility \? verified : false/);
  assert.match(verificationPolicy, /selector === '__picker_a_chat_lock__' \|\| selector === '__picker_b_chat_lock__'/);
  assert.match(verificationPolicy, /chat-lock:/);
});

test('v0.5.184 Work response stream pass counts as the native-response test without fabricating metadata', () => {
  const start = background.indexOf('async function discoverOfficialWorkModels');
  const end = background.indexOf('async function publishAccountModels', start);
  const body = background.slice(start, end);
  assert.match(body, /nativeResponseObserved = successfulConversationResponseEvidence\(responseEvidence\)/);
  assert.match(body, /nativeVerified = selection\.selectionAttempted === true/);
  assert.match(body, /nativeResponseConfirmed,\s*nativeResponseMetadataConfirmed: nativeResponseConfirmed/);
  assert.doesNotMatch(body, /nativeResponseConfirmed: nativeVerified/);
  assert.match(body, /nativeResponseMetadataConfirmed: nativeResponseConfirmed/);
});

test('v0.5.184 official Work accepts its owned selected-model summary only after the exact row click', () => {
  assert.match(content, /function pickerSelectedModelSummary/);
  assert.match(content, /modern\.pickerMode === 'B'/);
  assert.match(content, /pickerSelectedModelSummary\(modern\.picker, desired\)/);
  const selectionStart = content.indexOf('async function selectModelForVerification');
  const selectionEnd = content.indexOf('async function chooseExact', selectionStart);
  const selection = content.slice(selectionStart, selectionEnd);
  assert.ok(selection.indexOf("modelPickerPointer(candidate, 'click', 'verification-model-row')") >= 0);
  assert.ok(selection.indexOf('pickerSelectedModelSummary(modern.picker, desired)') > selection.indexOf("modelPickerPointer(candidate, 'click', 'verification-model-row')"));
});
