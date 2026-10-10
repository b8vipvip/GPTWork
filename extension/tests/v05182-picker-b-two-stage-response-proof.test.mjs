// Two-stage runtime regression from v0.5.181: Work response can be valid while resolved_model_slug is absent.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('Picker A-only discovery no longer executes the historical official Work/Picker B stage', () => {
  const verifyStart = background.indexOf('async function verifyAccountCatalogModels');
  const verifyEnd = background.indexOf('function modelVerificationHistoryRecord', verifyStart);
  assert.ok(verifyStart >= 0 && verifyEnd > verifyStart);
  const body = background.slice(verifyStart, verifyEnd);

  assert.match(body, /progress\.discoveryMode = 'picker-a-chat-only'/);
  assert.match(body, /picker_a_chat_lock_queued/);
  assert.match(body, /mode: chatCompatibility \? 'picker-a-ui-lock' : 'observe-native'/);
  assert.doesNotMatch(body, /await discoverOfficialWorkModels\(/);
  assert.doesNotMatch(body, /mergeCatalog\(officialWork\?\.chatCandidates/);
  assert.doesNotMatch(body, /officialWorkDiscoveryDone/);
});

test('v0.5.182 official Work success accepts exact request transport plus a successful response stream when resolved model metadata is hidden', () => {
  const start = background.indexOf('async function discoverOfficialWorkModels');
  const end = background.indexOf('async function publishAccountModels', start);
  assert.ok(start >= 0 && end > start);
  const body = background.slice(start, end);

  assert.match(body, /official_work_model_native_started/);
  assert.match(body, /allowModelMissing: true/);
  assert.match(body, /nativeResponseObserved = successfulConversationResponseEvidence\(responseEvidence\)/);
  assert.match(body, /nativeResponseCompatible = rawResponseModel/);
  assert.match(body, /nativeResponseConfirmed = Boolean\(rawResponseModel && nativeResponseCompatible\)/);
  assert.match(body, /nativeRequestConfirmed\s*&&\s*nativeResponseObserved\s*&&\s*nativeResponseCompatible !== false/);
  assert.match(body, /nativeVerificationBasis: nativeResponseConfirmed/);
  assert.match(body, /filter\(\(item\) => item\.nativeVerified && item\.nativeRequestModel\)/);
});

test('v0.5.191 Chat forced-lock proof requires served-model identity even when a response stream exists', () => {
  const helperStart = background.indexOf('function successfulConversationResponseEvidence');
  const helperEnd = background.indexOf('async function discoverOfficialWorkModels', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = background.slice(helperStart, helperEnd);
  assert.match(helper, /status >= 200/);
  assert.match(helper, /parsedObjectCount > 0 \|\| streamCaptureBytes > 0/);
  assert.match(helper, /allowModelMissing && successfulConversationResponseEvidence\(evidence\)/);

  const verifyStart = background.indexOf('async function verifyAccountCatalogModels');
  const verifyEnd = background.indexOf('function modelVerificationHistoryRecord', verifyStart);
  const body = background.slice(verifyStart, verifyEnd);
  assert.match(body, /allowModelMissing: chatCompatibility/);
  assert.match(body, /responseObserved = successfulConversationResponseEvidence\(responseEvidence\)/);
  assert.match(body, /const explicitResponseCompatible = Boolean\(/);
  assert.match(body, /rawResponseProtocolModel === expectedResponse/);
  assert.match(body, /chat_mode_response_model_not_exposed/);
  assert.match(body, /verified = Boolean\(requestId && requestConfirmed && responseConfirmed\)/);
  assert.match(body, /network_response_stream/);
  assert.match(body, /chatLockSupported: chatCompatibility \? verified : false/);
});

test('v0.5.191 rejects an explicitly exposed response model that disagrees with Work-native evidence', () => {
  const verifyStart = background.indexOf('async function verifyAccountCatalogModels');
  const verifyEnd = background.indexOf('function modelVerificationHistoryRecord', verifyStart);
  const body = background.slice(verifyStart, verifyEnd);
  assert.match(body, /rawResponseProtocolModel === expectedResponse/);
  assert.match(body, /expectedResponse\s*&&\s*rawResponseProtocolModel === expectedResponse/);
  assert.match(body, /chat_lock_picker_a_request_unconfirmed/);
});
