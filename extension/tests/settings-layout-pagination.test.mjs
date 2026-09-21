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
