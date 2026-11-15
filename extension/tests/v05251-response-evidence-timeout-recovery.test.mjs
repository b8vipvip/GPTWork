import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [background, contentScript] = await Promise.all([
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
  readFile(new URL('../content.js', import.meta.url), 'utf8'),
]);

test('ordinary request schedules a bounded response-evidence deadline', () => {
  assert.match(background, /const RESPONSE_EVIDENCE_TIMEOUT_MS = 120000;/);
  assert.match(background, /RESPONSE_EVIDENCE_TIMEOUT_PREFIX = 'gptwork-response-evidence-timeout:'/);
  assert.match(background, /if \(currentSettings\.networkVerificationEnabled && !verificationTransactionForTab\(tabId\)\) \{\s*scheduleResponseEvidenceTimeout\(tabId\);/);
  assert.match(background, /function scheduleResponseEvidenceTimeout\(tabId\)/);
});

test('missing response terminal cannot leave normal chat in waiting forever', () => {
  assert.match(background, /alarm\.name\.startsWith\(RESPONSE_EVIDENCE_TIMEOUT_PREFIX\)/);
  assert.match(background, /state\?\.phase === 'waiting' && state\.lastRequest\?\.requestId/);
  assert.match(background, /state\.phase = 'unverified';\s*state\.evidenceIssue = 'response_evidence_timeout';\s*state\.lastError = 'response_evidence_timeout';/);
  assert.match(background, /void broadcastTabState\(tabId\);/);
});

test('active downstream stream gets a short idle grace and terminal evidence clears the alarm', () => {
  assert.match(background, /streamRecentlyActive/);
  assert.match(background, /lastActivityAt \+ RESPONSE_STREAM_IDLE_GRACE_MS/);
  assert.match(background, /if \(evidence\?\.streamContext\?\.isDownstream === true \|\| !evidence\?\.diagnostics\?\.streamHandoff\) \{\s*clearResponseEvidenceTimeout\(tabId\);/);
  assert.match(background, /if \(detachedWhileWaiting\) \{\s*clearResponseEvidenceTimeout\(tabId\);/);
  assert.match(background, /clearResponseEvidenceTimeout\(tabId\);\s*$/m);
});

test('timeout is presented as unverified, not as a successful model confirmation', () => {
  assert.match(contentScript, /response_evidence_timeout: '响应确认超时；请求未被阻断，但模型尚未确认/);
});
