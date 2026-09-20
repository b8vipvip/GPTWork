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
  assert.match(content, /Single authority: first bind execution to the active composer/);
  assert.doesNotMatch(content, /const scored = candidates\.map/);
  assert.match(content, /if \(valueBearing\.length === 1\) return valueBearing\[0\]/);
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
  assert.match(content, /Single authority: first bind execution to the active composer/);
  assert.doesNotMatch(content, /const scored = candidates\.map/);
  assert.match(content, /if \(valueBearing\.length === 1\) return valueBearing\[0\]/);
  assert.match(content, /menu\.getAttribute\?\.\('aria-labelledby'\) === openerId/);
  assert.match(content, /gptlock-verification-progress-host/);
  assert.match(content, /bottom:52px/);
});


test('v0.5.82 follows the causal three-stage ChatGPT model picker', () => {
  assert.match(content, /function distinctModelRows/);
  assert.match(content, /function isModelListScope/);
  assert.match(content, /const beforeScopes = new Set\(modelPopupScopes\(\)\)/);
  assert.match(content, /await modelPickerPointer\(opener, 'click', 'model-picker-submenu'\)/);
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
  assert.match(content, /stableFrames < 2/);
  assert.match(content, /rejected_unstable_hit_test/);
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


// v0.5.86 fresh-chat regression: second layer is not the account catalog.
test('v0.5.86 does not mistake second-layer intelligence model summaries for the final catalog', () => {
  assert.match(content, /composer intelligence picker can expose two model-labelled rows/);
  assert.match(content, /scope\.matches\?\.\('\[data-testid="composer-intelligence-picker-content"\]'\)/);
  assert.match(content, /const openers = rows\.filter/);
  assert.match(content, /select model\|choose model\|选择模型\|選擇模型\|모델 선택/);
  assert.doesNotMatch(content, /if \(!scope \|\| isModelListScope\(scope\)\) return null/);
});


test('v0.5.87 uses one composer ownership boundary instead of selector accumulation', () => {
  assert.match(content, /function composerControlRegion/);
  assert.match(content, /one text-bearing menu control inside that owner/);
  assert.match(content, /querySelectorAll\('button\[aria-haspopup="menu"\],\[role="button"\]\[aria-haspopup="menu"\]'\)/);
  assert.doesNotMatch(content, /const selectors = \[\s*'\[data-testid="model-switcher-dropdown-button"\]'/);
});

test('v0.5.87 menu cleanup is idempotent and cannot toggle a closed model trigger open', () => {
  const start = content.indexOf('async function closeModelMenus');
  const end = content.indexOf('async function chooseModelExact', start);
  const closeBody = content.slice(start, end);
  assert.match(closeBody, /Escape owns dismissal/);
  assert.doesNotMatch(closeBody, /trustedPointer\(trigger/);
  assert.match(closeBody, /picker_close_incomplete/);
});

test('v0.5.87 progress starts before catalog discovery so discovery failure remains visible', () => {
  const verifyStart = background.indexOf('async function autoVerify');
  const verifyBody = background.slice(verifyStart, verifyStart + 7000);
  const runningAt = verifyBody.indexOf('state.autoVerification = {');
  const broadcastAt = verifyBody.indexOf('await broadcastTabState(tabId)', runningAt);
  const discoverAt = verifyBody.indexOf('const accountCatalog = await discoverAccountCatalog(tabId)');
  assert(runningAt >= 0 && broadcastAt > runningAt && discoverAt > broadcastAt);
  assert.match(verifyBody, /maxAttempts: 0/);
  assert.match(verifyBody, /state\.autoVerification\.maxAttempts = accountCatalog\.rows\.length/);
});


// v0.5.90 explicit legacy-core maintenance: remove quarantine and give execution one causal owner.
test('v0.5.90 executes only through the active composer model trigger', () => {
  assert.doesNotMatch(content, /MODEL_PICKER_MUTATION_QUARANTINED/);
  assert.match(content, /const valueBearing = menuTriggers\.filter/);
  assert.match(content, /if \(valueBearing\.length === 1\) return valueBearing\[0\]/);
  assert.doesNotMatch(content, /if \(menuTriggers\.length === 1\) return menuTriggers\[0\]/);
  assert.match(content, /page\/sidebar menus are outside/);
});

test('v0.5.90 binds first-layer picker to the exact trigger by relation or causal appearance', () => {
  assert.match(content, /function popupOwnedByTrigger/);
  assert.match(content, /const controlledId = trigger\.getAttribute\?\.\('aria-controls'\)/);
  assert.match(content, /scope\.getAttribute\?\.\('aria-labelledby'\) === triggerId/);
  assert.match(content, /const beforeTriggerScopes = new Set\(modelPopupScopes\(\)\)/);
  assert.match(content, /popupOwnedByTrigger\(trigger, beforeTriggerScopes\)/);
  assert.match(content, /newlyVisible\.length === 1 \? newlyVisible\[0\] : null/);
});

test('v0.5.90 observer remains page-wide read-only while executor stays transaction-scoped', () => {
  assert.match(content, /function startPassivePickerObserver/);
  assert.match(content, /passive_picker_snapshot/);
  assert.match(content, /DOM observation never performs clicks/);
  assert.match(content, /async function modelPickerPointer/);
  assert.match(content, /return trustedPointer\(element, action, source\)/);
  assert.doesNotMatch(content, /pickerKind: 'quarantined-passive'/);
});


test('v0.5.91 third-layer transition is owned by the exact accessible Select model control', () => {
  assert.match(content, /function modelSubmenuOpener\(picker\)/);
  assert.match(content, /select model\|choose model\|选择模型\|選擇模型\|모델 선택/);
  assert.match(content, /return openers\.length === 1 \? openers\[0\] : null/);
  assert.doesNotMatch(content, /const reasoningSignal = \/highest\|high\|medium\|low/);
});

test('v0.5.91 recent-chat menu provenance is observation-only', () => {
  assert.match(content, /external_menu_trigger_click/);
  assert.match(content, /isTrusted: event\.isTrusted === true/);
  assert.match(content, /if \(composer\?\.contains\?\.\(trigger\)\) return/);
});


test('v0.5.93 multi-window sync mutates only composer-owned controls and pauses for verification', async () => {
  const sync = await readFile(new URL('../multi-window-lock-sync.js', import.meta.url), 'utf8');
  assert.match(sync, /function activeComposerSurface/);
  assert.match(sync, /function ownedTrigger/);
  assert.match(sync, /\.\.\.composer\.querySelectorAll\(selector\)/);
  assert.doesNotMatch(sync, /selectors\.flatMap\(\(selector\) => \[\.\.\.document\.querySelectorAll\(selector\)\]\)\.find\(visible\)/);
  assert.match(sync, /!element\.closest\?\.\('\[data-testid\^="history-item-"\]'\)/);
  assert.match(sync, /dataset\?\.gptworkAutoVerification === 'running'/);
  assert.match(content, /document\.documentElement\.dataset\.gptworkAutoVerification = 'running'/);
});


test('v0.5.94 accepts only the composer-owned in-place advanced catalog after Select model activation', () => {
  assert.match(content, /const inPlaceCatalog = advancedPickerView\(picker\)/);
  assert.match(content, /visible\(inPlaceCatalog\) && distinctModelRows\(inPlaceCatalog\)\.length >= 2/);
  assert.match(content, /return inPlaceCatalog/);
  assert.match(content, /const opened = await modelPickerPointer\(opener, 'click', 'model-picker-submenu'\)/);
});


test('v0.5.95 verification dynamically converges a growing account model catalog', async () => {
  const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(background, /account_model_catalog_merged/);
  assert.match(background, /while \(index < queue\.length \|\| stablePasses < 2\)/);
  assert.match(background, /discoverAccountCatalog\(tabId\)/);
  assert.match(background, /mergeCatalog\(rediscovered, 'post-turn'\)/);
  assert.match(background, /mergeCatalog\(rediscovered, 'settle'\)/);
  assert.match(background, /progress\.total = queue\.length/);
  assert.match(background, /progress\.reasoningLevels = \[\.\.\.reasoningLevels\]/);
});


test('v0.5.96 waits for stable picker geometry and confirms the selected model before probing', async () => {
  assert.match(content, /stableFrames < 2/);
  assert.match(content, /rejected_unstable_hit_test/);
  assert.match(content, /verification_model_selection_confirmed/);
  assert.match(content, /collectObservation\(\)\.model === desired/);
  const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(background, /const requestModel = normalizeConcreteModelId\(state\.lastRequest\?\.model\)/);
  assert.doesNotMatch(background, /selected\\n\s+const requestModel/);
});

test('v0.5.96 diagnostics lazily pretty-print heavy runtime details', async () => {
  const diagnostics = await readFile(new URL('../diagnostics.js', import.meta.url), 'utf8');
  assert.match(diagnostics, /Expand to load details/);
  assert.match(diagnostics, /details\.addEventListener\('toggle'/);
  assert.match(diagnostics, /pre\.dataset\.loaded = '1'/);
});
