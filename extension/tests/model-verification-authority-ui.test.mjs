import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const networkMonitor = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const policy = await readFile(new URL('../policy.js', import.meta.url), 'utf8');
const settings = await readFile(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const popup = await readFile(new URL('../popup-v0513.html', import.meta.url), 'utf8');
const popupJs = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
const historyUi = await readFile(new URL('../model-verification-history-options.js', import.meta.url), 'utf8');

test('model verification separates request confirmation from backend response verification', () => {
  assert.match(content, /selectionAttempted/);
  assert.match(background, /body forwarded at Fetch\.requestPaused is the sole request-confirmation/);
  assert.match(background, /requestModel === item\.model/);
  assert.match(background, /responseModel === item\.model/);
  assert.match(background, /responseConfirmed/);
  assert.match(background, /evidenceModel = responseModel \|\| \(requestConfirmed \? requestModel : null\)/);
  assert.match(background, /sendVerificationReasoningProbe\(tabId, 'GPTWork 模型验证'/);
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

test('v0.5.134 uses a different deterministic answer for every verification turn', () => {
  assert.match(background, /const n = Math\.max\(1, Number\(ordinal\) \|\| 1\)/);
  assert.match(background, /const left = 120 \+ \(n \* 7\)/);
  assert.match(background, /const right = 31 \+ \(n \* 5\)/);
  assert.match(background, /const offset = \(n \* n\) \+ 17/);
  assert.match(background, /校验值=<整数>/);
  assert.doesNotMatch(background, /a\+b\+c=18/);
});

test('v0.5.134 verifies GPT-5.5 before taking temporary Work-mode ownership', () => {
  const verifyStart = background.indexOf('async function verifyAccountCatalogModels');
  const verifyEnd = background.indexOf('async function autoVerify', verifyStart);
  const verifyBody = background.slice(verifyStart, verifyEnd);
  const completed = verifyBody.indexOf("if (item.model === 'gpt-5.5')");
  const work = verifyBody.indexOf("GPTLOCK_VERIFY_ENTER_WORK_MODE", completed);
  const rediscover = verifyBody.indexOf('let rediscovered = await discoverAccountCatalog(tabId)', completed);
  assert(completed >= 0 && work > completed && rediscover > work);

  const autoStart = background.indexOf('async function autoVerify');
  const autoBody = background.slice(autoStart);
  const initialDiscovery = autoBody.indexOf('const accountCatalog = await discoverAccountCatalog(tabId)');
  const verification = autoBody.indexOf('verifyAccountCatalogModels', initialDiscovery);
  const prematureWork = autoBody.indexOf('GPTLOCK_VERIFY_ENTER_WORK_MODE', initialDiscovery);
  assert(initialDiscovery >= 0 && verification > initialDiscovery);
  assert(prematureWork < 0 || prematureWork > verification);
  assert.match(autoBody, /deferred_until_after_gpt_5_5/);
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
  assert.match(background, /getVerificationTransaction\(tabId\)/);
  assert.match(networkMonitor, /effectiveConfiguration\(tabId\)/);
  assert.match(networkMonitor, /authorityKind: 'verification-transaction'/);
  assert.match(networkMonitor, /forceModel: model/);
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
  const verifyBody = background.slice(verifyStart, verifyStart + 9000);
  const runningAt = verifyBody.indexOf('state.autoVerification = {');
  const broadcastAt = verifyBody.indexOf('await broadcastTabState(tabId)', runningAt);
  const discoverAt = verifyBody.indexOf('const accountCatalog = await discoverAccountCatalog(tabId)');
  assert(runningAt >= 0 && broadcastAt > runningAt && discoverAt > broadcastAt);
  assert.match(verifyBody, /maxAttempts: 0/);
  assert.match(verifyBody, /state\.autoVerification\.maxAttempts = accountCatalog\.rows\.length/);
  assert.match(verifyBody, /deferred_until_after_gpt_5_5/);
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
  assert.match(content, /trustedPointer\(element, action/);
  assert.match(content, /if \(!element\?\.isConnected \|\| !visible\(element\)\) return false/);
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
  assert.match(background, /const networkObservedRequestModel = normalizeConcreteModelId\(state\.lastRequest\?\.model\)/);
  assert.match(background, /normalizeConcreteModelId\(state\.lastRewrite\?\.modelAfter\)/);
  assert.doesNotMatch(background, /selected\\n\s+const requestModel/);
});

test('v0.5.97 accepts the exact owned catalog radio state as selection acknowledgement', () => {
  assert.match(content, /candidate\.getAttribute\('data-state'\) === 'checked'/);
  assert.match(content, /return collectObservation\(\)\.model === desired/);
  assert.match(content, /verification_model_selection_confirmed/);
});

test('v0.5.98 ignores hidden stale stop controls between verification models', () => {
  assert.match(content, /function visibleGeneratingControl\(\)/);
  assert.match(content, /querySelectorAll\(selector\)/);
  assert.match(content, /find\(\(element\) => visible\(element\)\)/);
  assert.match(content, /const snapshot = idleSnapshot\(\)/);
  assert.match(content, /if \(!snapshot\.generating\) return snapshot/);
  assert.doesNotMatch(content, /!document\.querySelector\(GENERATING_SELECTORS\.join\(','\)\)/);
});


test('v0.5.99 response evidence remains partial-safe while v0.5.120 owns verification at Fetch', async () => {
  const monitor = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');
  const options = await readFile(new URL('../options.js', import.meta.url), 'utf8');
  assert.match(monitor, /effectiveConfiguration\(tabId\)/);
  assert.match(monitor, /authorityKind: 'verification-transaction'/);
  assert.match(monitor, /verification_authority_mismatch_blocked/);
  assert.match(monitor, /hasResponseMetadataEvidence/);
  assert.match(background, /lastResponseEvidence/);
  assert.match(background, /responseConfirmed/);
  assert.match(background, /catalogRequestConfirmed/);
  assert.match(content, />执行进度</);
  assert.match(content, />验证成功</);
  assert.match(options, /执行进度/);
  assert.match(options, /验证成功/);
});


test('v0.5.100 correlates response evidence to the active formal request', () => {
  assert.match(background, /function responseEvidenceRequestId\(evidence\)/);
  assert.match(background, /evidence\?\.streamContext\?\.initialRequestId\s*\|\|\s*evidence\?\.requestId/);
  assert.match(background, /response_evidence_ignored_stale_request/);
  assert.match(background, /state\.lastVerification\?\.requestId === `cdp-\$\{tabId\}-\$\{requestId\}`/);
  assert.match(background, /state\.lastResponseEvidence\?\.requestId === requestId/);
});


test('v0.5.107 distinguishes picker A/B from live topology rather than URL', () => {
  assert.match(content, /Picker topology is a runtime capability, not a URL property/);
  assert.match(content, /picker-mode-a-direct-model-list/);
  assert.match(content, /pickerMode: 'A'/);
  assert.match(content, /pickerMode: 'B'/);
  assert.doesNotMatch(content, /pageContext === 'new_chat'/);
});

test('v0.5.101 verification history supports reports, clear and eight-row pagination', () => {
  assert.match(historyUi, /const PAGE_SIZE = 8/);
  assert.match(historyUi, /modelVerificationHistoryClear/);
  assert.match(historyUi, /导出报告/);
  assert.match(historyUi, /downloadReport/);
});


test('v0.5.102 accepts an already checked owned model row on new chat', () => {
  assert.match(content, /verification-model-row-already-checked/);
  assert.match(content, /candidate\.getAttribute\('data-state'\) === 'checked'/);
});

test('v0.5.102 canonicalizes wm transport ids for discovered model families', async () => {
  const policy = await readFile(new URL('../policy.js', import.meta.url), 'utf8');
  assert.match(policy, /'gpt-5\.6-terra-wm': 'gpt-5\.6-terra'/);
  assert.match(policy, /'gpt-5\.6-luna-wm': 'gpt-5\.6-luna'/);
  assert.match(policy, /'gpt-5\.5-wm': 'gpt-5\.5'/);
});


test('v0.5.103 verification is the sole send authority while its transaction is active', () => {
  assert.match(content, /cachedState\?\.autoVerification\?\.running === true/);
  assert.match(background, /if \(!verification && !guard\.canSend\)/);
  assert.match(background, /networkVerificationEnabled: true/);
  assert.match(background, /autoAlignSelection: false/);
  assert.match(networkMonitor, /forceModel: model/);
});

test('v0.5.103 runtime log delivery is event-driven from one canonical browser log', () => {
  assert.match(background, /scheduleRuntimeLogDelivery/);
  assert.match(background, /uploadRuntimeLogBatch/);
  assert.match(background, /syncRuntimeLogsToNative/);
  assert.match(background, /same immutable entry ids/);
});


test('v0.5.104 verification survives new-chat navigation without CDP detach', () => {
  assert.match(background, /verificationTransactionForTab\(tab\.id\)\) await networkMonitor\.attach/);
  assert.match(networkMonitor, /forceModel: model/);
});

test('v0.5.104 ordinary typing does not trigger full page observation', () => {
  assert.match(content, /mutation\.type === 'characterData'\) return false/);
  assert.match(content, /textarea,\[contenteditable="true"\]/);
  assert.match(content, /Full popup topology scans are diagnostic work/);
});


test('v0.5.105 dynamic catalog converges by stable model identity', () => {
  assert.match(background, /function|const catalogIdentity/);
  assert.match(background, /if \(model\) return \`model:\$\{model\}\`/);
  assert.match(background, /if \(knownKeys\.has\(key\)\)/);
  assert.match(background, /uniqueModels: knownKeys\.size/);
  assert.doesNotMatch(background, /\[model \|\| '', rawModel \|\| '', selectorKey, label\]\.join/);
});

test('v0.5.105 progress UI separates executed work from growing discovery', () => {
  assert.match(content, /已执行 · \$\{total\} 已发现/);
  assert.match(content, /模型验证 · 已执行/);
});


test('v0.5.106 normalizes GPT-5.6 thinking transport and records performance evidence', () => {
  assert.match(policy, /'gpt-5-6-thinking': 'gpt-5\.6-sol'/);
  assert.match(background, /GPTLOCK_PERFORMANCE_DIAGNOSTIC/);
  assert.match(background, /page_responsiveness_sample/);
  assert.match(background, /verificationActive: Boolean\(verification\)/);
  assert.match(content, /PerformanceObserver/);
  assert.match(content, /eventLoopLagMs/);
  assert.match(content, /maxMutationCallbackMs/);
});


test('v0.5.107 rechecks verification authority before mutation and scopes full network capture', async () => {
  const monitor = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');
  assert.match(monitor, /verification_passthrough_late_authority/);
  assert.match(monitor, /configuration = this\.configuration\(tabId\)/);
  assert.match(monitor, /enableResponseCapture/);
  assert.match(monitor, /disableResponseCapture/);
  assert.match(background, /verification_response_capture/);
});


test('v0.5.108 shares verified model metadata without treating it as account access', async () => {
  const accountClient = await readFile(new URL('../account-client.js', import.meta.url), 'utf8');
  const catalogOptions = await readFile(new URL('../model-catalog-options.js', import.meta.url), 'utf8');
  assert.match(accountClient, /sharedModelCatalog/);
  assert.match(accountClient, /publishSharedModels/);
  assert.match(background, /shared_model_catalog_published/);
  assert.match(background, /requestConfirmed === true/);
  assert.match(background, /pickerModes/);
  assert.match(catalogOptions, /当前账户仍需验证/);
});

test('v0.5.108 canonicalizes GPT-5.5 instant and clears contradictory response issue', () => {
  assert.match(policy, /'gpt-5-5-instant': 'gpt-5\.5'/);
  assert.match(background, /responseIssue: responseConfirmed \? null/);
});


test('v0.5.108 popup can persist an empty locked-model list', () => {
  assert.doesNotMatch(popupJs, /至少保留一个锁定模型/);
  assert.match(popupJs, /已取消全部模型锁定/);
  assert.match(popupJs, /lockedModels: selected/);
});


test('v0.5.109 verification owns Work discovery independently and waits for terminal replies', () => {
  assert.match(background, /GPTLOCK_VERIFY_ENTER_WORK_MODE/);
  assert.match(background, /verification_work_mode_transition/);
  assert.match(background, /mergeAccountCatalogs/);
  assert.match(background, /GPTLOCK_WAIT_FOR_PROBE_SETTLED/);
  assert.match(background, /account_model_verification_aborted_pending_response/);
  assert.match(content, /verificationWorkControl/);
  assert.match(content, /verification-work-mode/);
  assert.match(content, /waitForProbeTurnSettled/);
  assert.match(content, /assistantCountBefore/);
  assert.match(content, /stillGenerating/);
});

test('v0.5.111 performance diagnostics stay compact and sample every 30 seconds', () => {
  assert.match(content, /function lightElementProbe/);
  assert.match(content, /periodicDue = now - performanceTelemetry\.lastReportedAt >= 30000/);
  assert.match(content, /performanceTickVisibility/);
  assert.match(content, /performance\.now\(\) \+ 5000/);
  assert.doesNotMatch(content, /composerControls,/);
});


test('v0.5.120 resolves verification authority at the Fetch sink and fails closed on mismatch', () => {
  assert.match(networkMonitor, /Resolve authority only after postData acquisition/);
  assert.match(networkMonitor, /configuration = this\.effectiveConfiguration\(tabId\)/);
  assert.match(networkMonitor, /verification_authority_mismatch_blocked/);
  assert.match(networkMonitor, /await this\.failPaused\(tabId, requestId\)/);
  assert.match(networkMonitor, /verification_rewrite_failed_closed/);
  assert.match(background, /state\.lastRewrite\?\.authorityKind === 'verification-transaction'/);
  assert.match(background, /networkObservedRequestModel/);
  assert.match(background, /fetch_forwarded_request_metadata/);
  assert.match(background, /const verified = Boolean\(requestId\) && requestConfirmed && responseConfirmed/);
});
