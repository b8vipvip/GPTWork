// Two-stage runtime regression from v0.5.181: Work response can be valid while resolved_model_slug is absent.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('v0.5.182 completes the whole official Work Picker-B pass before Chat forced-lock verification is queued', () => {
  const verifyStart = background.indexOf('async function verifyAccountCatalogModels');
  const verifyEnd = background.indexOf('function modelVerificationHistoryRecord', verifyStart);
  assert.ok(verifyStart >= 0 && verifyEnd > verifyStart);
  const body = background.slice(verifyStart, verifyEnd);

  const discoverCall = body.indexOf('const officialWork = await discoverOfficialWorkModels(tabId, progress)');
  const mergeChatCandidates = body.indexOf("mergeCatalog(officialWork?.chatCandidates, 'picker-b-chat-compatibility')");
  assert.ok(discoverCall >= 0 && mergeChatCandidates > discoverCall);
  assert.match(body, /mode: chatCompatibility \? 'force-transport' : 'observe-native'/);
  assert.match(body, /selectorKey === '__picker_b_chat_lock__'/);
});

test('v0.5.182 official Work success accepts exact request transport plus a successful response stream when resolved model metadata is hidden', () => {
  const start = background.indexOf('async function discoverOfficialWorkModels');
  const end = background.indexOf('async function publishAccountModels', start);
  assert.ok(start >= 0 && end > start);
  const body = background.slice(start, end);

  assert.match(body, /official_work_model_native_started/);
  assert.match(body, /allowModelMissing: true/);
  assert.match(body, /nativeResponseObserved = successfulConversationResponseEvidence\(responseEvidence\)/);
  assert.match(body, /nativeResponseCompatible = !rawResponseModel/);
  assert.match(body, /nativeRequestConfirmed\s*&&\s*nativeResponseObserved\s*&&\s*nativeResponseCompatible/);
  assert.match(body, /nativeVerificationBasis: nativeResponseConfirmed/);
  assert.match(body, /filter\(\(item\) => item\.nativeVerified && item\.nativeRequestModel\)/);
});

test('v0.5.182 Chat forced-lock proof accepts a successful response stream without requiring resolved_model_slug', () => {
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
  assert.match(body, /explicitResponseCompatible = !rawResponseProtocolModel/);
  assert.match(body, /verified = Boolean\(requestId && requestConfirmed && responseConfirmed\)/);
  assert.match(body, /network_response_stream/);
  assert.match(body, /chatLockSupported: chatCompatibility \? verified : false/);
});

test('v0.5.182 still rejects an explicitly exposed response model that disagrees with the selected Picker-B model', () => {
  const verifyStart = background.indexOf('async function verifyAccountCatalogModels');
  const verifyEnd = background.indexOf('function modelVerificationHistoryRecord', verifyStart);
  const body = background.slice(verifyStart, verifyEnd);
  assert.match(body, /rawResponseProtocolModel === expectedResponse/);
  assert.match(body, /normalizeConcreteModelId\(rawResponseProtocolModel\) === item\.model/);
  assert.match(body, /chat_mode_response_differs_from_official_work/);
});
