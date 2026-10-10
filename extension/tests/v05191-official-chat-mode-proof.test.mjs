// v0.5.191: official Chat mode is an explicit, single-owner proof gate.
// No URL-only, stream-only or request-rewrite-only compatibility promotion.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [background, content, server] = await Promise.all([
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
  readFile(new URL('../content.js', import.meta.url), 'utf8'),
  readFile(new URL('../../license-server/account-system-base.mjs', import.meta.url), 'utf8'),
]);

function block(source, from, to) {
  const i = source.indexOf(from);
  const j = source.indexOf(to, i + from.length);
  assert.ok(i >= 0 && j > i, `Missing scope ${from}`);
  return source.slice(i, j);
}

test('only the content runtime knows whether the official Picker A/Chat mode is active', () => {
  const mode = block(content, 'function verificationChatControl()', 'async function enterVerificationWorkMode()');
  assert.match(content, /const VERIFICATION_CHAT_LABEL =/);
  assert.match(mode, /const picker = await openModernModelMenu\(\)/);
  assert.match(mode, /pickerMode: picker\?\.pickerMode \|\| null/);
  assert.match(mode, /await closeModelMenus\(picker\?\.trigger\)/);
  assert.match(mode, /const deadline = Date\.now\(\) \+ 7500/);
  assert.match(mode, /if \(before\.pickerMode === 'A'\)/);
  assert.match(mode, /if \(!switchIfNeeded \|\| before\.pickerMode !== 'B'\)/);
  assert.match(mode, /const control = verificationChatControl\(\)/);
  assert.match(mode, /trustedPointer\(control, 'click', 'verification-official-chat-mode'\)/);
  assert.match(mode, /confirmed: after\.pickerMode === 'A'/);
  assert.match(content, /message\?\.type === 'GPTLOCK_VERIFY_OFFICIAL_CHAT_MODE'/);
  assert.doesNotMatch(mode, /location\.pathname === '\/'\s*\?/);
});

test('every forced Chat-lock turn verifies Picker A before dispatch and after response', () => {
  const helper = block(background, 'async function requireVerificationOfficialChatMode', 'async function pinSharedChatLockConversation');
  assert.match(helper, /type: 'GPTLOCK_VERIFY_OFFICIAL_CHAT_MODE'/);
  assert.match(helper, /verdict\?\.confirmed !== true/);
  assert.match(helper, /official_chat_mode_unconfirmed/);
  assert.match(helper, /switchIfNeeded: true/);
  const loop = block(background, 'async function verifyAccountCatalogModels', 'function modelVerificationHistoryRecord');
  const before = loop.indexOf('prepareSharedChatLockVerificationSurface(tabId, ownerTabId, item, sharedChatLockSession)');
  const probe = loop.indexOf('const probe = await sendVerificationReasoningProbe');
  const after = loop.lastIndexOf('requireVerificationOfficialChatMode(tabId, item, { switchIfNeeded: false })');
  assert.ok(before >= 0 && probe > before && after > probe);
  assert.match(background, /Isolated Chat lock mode transition left new Chat/);
});

test('network stream without raw served-model evidence never proves Chat compatibility', () => {
  const loop = block(background, 'async function verifyAccountCatalogModels', 'function modelVerificationHistoryRecord');
  assert.match(loop, /const explicitResponseCompatible = Boolean\(\s*rawResponseProtocolModel\s*&& expectedResponse\s*&& rawResponseProtocolModel === expectedResponse/s);
  assert.match(loop, /chat_mode_response_model_not_exposed/);
  assert.match(loop, /native_response_model_not_exposed/);
  assert.match(loop, /chatLockSupported: chatCompatibility \? verified : false/);
  assert.match(loop, /chatVerificationBasis: chatCompatibility && verified\s*\? 'official_picker_a_selection\+request_transport\+response_model'/);
  assert.doesNotMatch(loop, /explicitResponseCompatible = !rawResponseProtocolModel/);
  assert.doesNotMatch(loop, /forced_transport\+response_stream/);
});

test('server replaces stale account Chat proof rather than permanently OR-ing positives', () => {
  const merge = block(server, 'function mergeSharedModelCatalog(inputModels, userId)', 'function updateSharedModelCatalog');
  assert.match(merge, /chat_lock_request_confirmed=CASE WHEN excluded\.chat_lock_stage_complete=1/);
  assert.match(merge, /chat_lock_response_confirmed=CASE WHEN excluded\.chat_lock_stage_complete=1/);
  assert.match(merge, /chat_transport_model=CASE WHEN excluded\.chat_lock_stage_complete=1/);
  assert.match(merge, /chat_response_model=CASE WHEN excluded\.chat_lock_stage_complete=1/);
  assert.match(merge, /clearUnprovenChatTransport\.run\(model\)/);
  assert.match(merge, /Boolean\(seenBefore\?\.chat_lock_response_confirmed\) !== chatLockResponseConfirmed/);
  assert.doesNotMatch(merge, /chat_lock_response_confirmed=MAX\(/);
});
