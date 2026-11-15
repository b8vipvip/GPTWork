import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Regression coverage for the browser-runtime response watchdog.

const [background, contentScript, manifest] = await Promise.all([
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
  readFile(new URL('../content.js', import.meta.url), 'utf8'),
  readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
]);

test('ordinary request schedules a bounded response-evidence deadline scoped to its request ID', () => {
  assert.match(background, /const RESPONSE_EVIDENCE_TIMEOUT_MS = 120000;/);
  assert.match(background, /RESPONSE_EVIDENCE_TIMEOUT_PREFIX = 'gptwork-response-evidence-timeout:'/);
  assert.match(background, /scheduleResponseEvidenceTimeout\(tabId, request\.requestId\)/);
  assert.match(background, /function scheduleResponseEvidenceTimeout\(tabId, requestId\)/);
  assert.match(background, /clearResponseEvidenceTimeout\(tabId, previousRequestId\)/);
});

test('alarm scheduling supports Chrome 110 void returns and Chrome 111+ promises', () => {
  assert.match(manifest, /"minimum_chrome_version": "110"/);
  assert.match(background, /function createResponseEvidenceAlarm\\(tabId, requestId, when\\)/);
  assert.match(background, /const result = chrome\\.alarms\\.create/);
  assert.match(background, /if \\(result && typeof result\\.catch === 'function'\\)/);
  assert.match(background, /createResponseEvidenceAlarm\\(tabId, requestId, lastActivityAt \\+ RESPONSE_STREAM_IDLE_GRACE_MS\\)/);
});

test('missing response terminal cannot leave the matching request waiting forever', () => {
  assert.match(background, /alarm\.name\.startsWith\(RESPONSE_EVIDENCE_TIMEOUT_PREFIX\)/);
  assert.match(background, /state\?\.phase === 'waiting' && requestId && state\.lastRequest\?\.requestId === requestId/);
  assert.match(background, /state\.phase = 'unverified';\s*state\.evidenceIssue = 'response_evidence_timeout';\s*state\.lastError = 'response_evidence_timeout';/);
  assert.match(background, /void broadcastTabState\(tabId\);/);
});

test('active downstream stream gets a short idle grace and terminal evidence clears its alarm', () => {
  assert.match(background, /streamRecentlyActive/);
  assert.match(background, /responseEvidenceAlarmName\(tabId, requestId\)/);
  assert.match(background, /lastActivityAt \+ RESPONSE_STREAM_IDLE_GRACE_MS/);
  assert.match(background, /if \(evidence\?\.streamContext\?\.isDownstream === true \|\| !evidence\?\.diagnostics\?\.streamHandoff\) \{\s*clearResponseEvidenceTimeout\(tabId\);/);
  assert.match(background, /if \(detachedWhileWaiting\) \{\s*clearResponseEvidenceTimeout\(tabId\);/);
  assert.match(background, /clearResponseEvidenceTimeout\(tabId\);\s*$/m);
});

test('timeout is presented as unverified, not as a successful model confirmation', () => {
  assert.match(contentScript, /response_evidence_timeout: '响应确认超时；请求未被阻断，但模型尚未确认/);
});
