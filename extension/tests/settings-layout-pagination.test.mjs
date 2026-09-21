import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const settingsHtml = await readFile(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const historyOptionsSource = await readFile(new URL('../request-history-options.js', import.meta.url), 'utf8');
const historyCss = await readFile(new URL('../request-history.css', import.meta.url), 'utf8');
const verificationHistorySource = await readFile(new URL('../model-verification-history-options.js', import.meta.url), 'utf8');
const backgroundSource = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const lifecycleSource = await readFile(new URL('../content-runtime-lifecycle.js', import.meta.url), 'utf8');
const runtimeLogSource = await readFile(new URL('../runtime-log.js', import.meta.url), 'utf8');
const networkMonitorSource = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');
function requireSource(relativePath) {
  return requireSource.cache.get(relativePath);
}
requireSource.cache = new Map([
  ['../work-mode-controller.js', await readFile(new URL('../work-mode-controller.js', import.meta.url), 'utf8')],
  ['../context-budget.js', await readFile(new URL('../context-budget.js', import.meta.url), 'utf8')],
]);

test('compact lock editor sits directly after feature gates and request history is the last settings card', () => {
  const featureIndex = settingsHtml.indexOf('id="globalHeading"');
  const lockIndex = settingsHtml.indexOf('id="lockSummaryHeading"');
  const historyIndex = settingsHtml.indexOf('id="requestHistoryHeading"');
  const footerIndex = settingsHtml.indexOf('<footer>');

  assert(featureIndex >= 0);
  assert(lockIndex > featureIndex);
  assert(historyIndex > lockIndex);
  assert(footerIndex > historyIndex);
  assert.doesNotMatch(settingsHtml, /id="updateHeading"/);
  assert.doesNotMatch(settingsHtml, /id="updates"/);
  assert.doesNotMatch(settingsHtml, /Response verification|Enforcement mode|id="networkVerification"|name="mode"/);
  assert.equal(settingsHtml.lastIndexOf('<section'), settingsHtml.lastIndexOf('<section class="card request-history-card"'));
});

test('request history pagination renders eight records per page with previous and next controls', () => {
  assert.match(settingsHtml, /id="requestHistoryPagination"/);
  assert.match(settingsHtml, /id="requestHistoryPrev"/);
  assert.match(settingsHtml, /id="requestHistoryNext"/);
  assert.match(settingsHtml, /id="requestHistoryPageInfo"/);
  assert.match(historyOptionsSource, /const PAGE_SIZE = 8;/);
  assert.match(historyOptionsSource, /currentRecords\.slice\(start, start \+ PAGE_SIZE\)/);
  assert.match(historyOptionsSource, /currentPage \+= 1/);
  assert.match(historyOptionsSource, /currentPage -= 1/);
  assert.match(historyCss, /\.request-history-pagination/);
});


test('v0.5.110 Settings keeps request history off the runtime-log hot path', () => {
  assert.match(historyOptionsSource, /historyDirty = true/);
  assert.match(historyOptionsSource, /refreshIfDirty/);
  assert.match(historyOptionsSource, /visibilitychange/);
  assert.doesNotMatch(historyOptionsSource, /setTimeout\(\(\) => void refreshHistory\(\).*80/);
});


test('request and model-verification histories are opt-in and default off', () => {
  assert.match(settingsHtml, /id="requestHistoryEnabled"/);
  assert.match(settingsHtml, /id="modelVerificationHistoryEnabled"/);
  assert.match(historyOptionsSource, /gptworkRequestHistoryEnabled/);
  assert.match(historyOptionsSource, /stored\[REQUEST_HISTORY_ENABLED_KEY\] === true/);
  assert.match(verificationHistorySource, /gptworkModelVerificationHistoryEnabled/);
  assert.match(verificationHistorySource, /stored\[MODEL_VERIFICATION_HISTORY_ENABLED_KEY\] === true/);
  assert.match(backgroundSource, /stored\[MODEL_VERIFICATION_HISTORY_ENABLED_KEY\] !== true\) return null/);
});


test('v0.5.111 diagnostics attribute runtime callback pressure and preserve ordered verification evidence', () => {
  assert.match(lifecycleSource, /diagnosticsSnapshot/);
  assert.match(lifecycleSource, /callbackStats/);
  assert.match(contentSource, /runtimeLifecycle/);
  assert.match(contentSource, /performanceTickVisibility/);
  assert.match(backgroundSource, /networkMonitor\.diagnosticsSnapshot\(\{ reset: true \}\)/);
  assert.match(runtimeLogSource, /RUNTIME_LOG_SESSION_ID/);
  assert.match(runtimeLogSource, /component === 'verification'/);
  assert.match(runtimeLogSource, /sequence: runtimeLogSequence/);
});


test('v0.5.112 diagnostics identify concrete slow callback sources and long-task attribution', () => {
  assert.match(lifecycleSource, /callbackSourceStats/);
  assert.match(lifecycleSource, /recentSlowCallbacks/);
  assert.match(lifecycleSource, /SLOW_CALLBACK_MS = 20/);
  assert.match(contentSource, /recentLongTasks/);
  assert.match(contentSource, /entry\.attribution/);
  assert.match(backgroundSource, /recentLongTasks: sanitizeLogValue/);
});

test('v0.5.112 suppresses transcript-stream mutation churn and ignores disabled stop controls', () => {
  assert.match(contentSource, /target\.closest\?\.\('\[data-message-author-role\]'\)/);
  assert.match(contentSource, /element\.getAttribute\?\.\('aria-disabled'\) !== 'true'/);
  assert.match(contentSource, /transcript streaming is extremely mutation-heavy/);
});


test('v0.5.113 removes high-frequency full-document Work and context polling', () => {
  const workModeSource = requireSource('../work-mode-controller.js');
  const contextBudgetSource = requireSource('../context-budget.js');
  assert.doesNotMatch(workModeSource, /querySelectorAll\('span,div'\)/);
  assert.match(workModeSource, /querySelectorAll\('h1,h2,button,span,\[data-tpp-source-group-toggle\]'\)/);
  assert.doesNotMatch(workModeSource, /attributeFilter: \['aria-selected'/);
  assert.match(contextBudgetSource, /const PERIODIC_REFRESH_MS = 30_000;/);
  assert.match(contextBudgetSource, /window\.setInterval\(scheduleRefresh, PERIODIC_REFRESH_MS\)/);
});


test('v0.5.114 exposes hard A/B jank isolation gates', () => {
  assert.match(backgroundSource, /GPTWORK_SET_JANK_ISOLATION/);
  assert.match(backgroundSource, /jank_isolation_changed/);
  assert.match(contentSource, /GPTWORK_DIAGNOSTIC_CONTENT_SUSPEND/);
  assert.match(contentSource, /__GPTWORK_DIAGNOSTIC_CONTENT_SUSPENDED__/);
  assert.match(networkMonitorSource, /setDiagnosticSuspended/);
  assert.match(networkMonitorSource, /diagnostic_cdp_suspended/);
});

test('v0.5.114 verification can ignore only a stale generating control after terminal UI stability', () => {
  assert.match(contentSource, /staleGeneratingControlIgnored/);
  assert.match(contentSource, /snapshot\.composerVisible && snapshot\.sendReady/);
  assert.match(contentSource, /Date\.now\(\) - stableSince >= 1500/);
});


test('v0.5.116 keeps known page selection authoritative across UI alignment and request lock', () => {
  assert.match(backgroundSource, /knownModels: \[\.\.\.sharedKnownModelIds\]/);
  assert.match(backgroundSource, /knownModels: \[\.\.\.sharedKnownModelIds\]/);
  assert.match(contentSource, /pageModelIsKnown/);
  assert.match(contentSource, /!pageModelIsKnown && observation\.model !== desiredModel/);
});

test('v0.5.116 rejects reasoning-decorated pseudo model rows', () => {
  assert.match(contentSource, /reasoningDecorated/);
  assert.match(contentSource, /!descriptor\.explicitModelId/);
  assert.match(contentSource, /explicitModelId/);
});

test('v0.5.116 distinguishes backend resolution metadata from selected-model evidence', () => {
  assert.match(backgroundSource, /verificationResponseObservation/);
  assert.match(backgroundSource, /backend_resolution_not_selected_model/);
  assert.match(backgroundSource, /backend_model_resolution_observed/);
  assert.match(backgroundSource, /selectedModelEvidenceDowngraded/);
});
