import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RESPONSE_EVIDENCE_TIMEOUT_MS,
  createResponseEvidenceWatchdog,
  touchResponseEvidenceWatchdog,
  isResponseEvidenceWatchdogExpired,
} from '../response-watchdog.js';
import { readFile } from 'node:fs/promises';

test('new watchdog starts an inactivity deadline for the exact send/request key', () => {
  const watchdog = createResponseEvidenceWatchdog('request:tab-4.req-1', 1000);
  assert.equal(watchdog.key, 'request:tab-4.req-1');
  assert.equal(watchdog.startedAt, 1000);
  assert.equal(watchdog.lastActivityAt, 1000);
  assert.equal(watchdog.deadlineAt, 1000 + DEFAULT_RESPONSE_EVIDENCE_TIMEOUT_MS);
  assert.equal(watchdog.activityCount, 0);
});

test('only activity for the same request refreshes the inactivity deadline', () => {
  const watchdog = createResponseEvidenceWatchdog('request:req-1', 1000, 120000);
  const refreshed = touchResponseEvidenceWatchdog(watchdog, 'request:req-1', 45000, 120000);
  assert.equal(refreshed.startedAt, 1000);
  assert.equal(refreshed.lastActivityAt, 45000);
  assert.equal(refreshed.deadlineAt, 165000);
  assert.equal(refreshed.activityCount, 1);

  const stale = touchResponseEvidenceWatchdog(refreshed, 'request:req-old', 90000, 120000);
  assert.equal(stale, refreshed, 'late events from a previous request must not refresh this watchdog');
});

test('watchdog expires at its deadline and never before it', () => {
  const watchdog = createResponseEvidenceWatchdog('send:4:2', 500, 45000);
  assert.equal(isResponseEvidenceWatchdogExpired(watchdog, 'send:4:2', 45499), false);
  assert.equal(isResponseEvidenceWatchdogExpired(watchdog, 'send:4:2', 45500), true);
  assert.equal(isResponseEvidenceWatchdogExpired(watchdog, 'send:4:1', 45500), false);
});

test('invalid keys and timeouts cannot create or expire watchdogs', () => {
  assert.equal(createResponseEvidenceWatchdog('', 1000), null);
  assert.equal(createResponseEvidenceWatchdog('req', 1000, 0), null);
  assert.equal(isResponseEvidenceWatchdogExpired(null, 'req', 999999), false);
});

test('background and network lifecycle wire the watchdog without promoting timeouts to verified', async () => {
  const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
  const [background, network, guard, content] = await Promise.all([
    read('background.js'), read('network-monitor.js'), read('guard.js'), read('content.js'),
  ]);
  assert.match(background, /RESPONSE_EVIDENCE_ALARM_PREFIX/);
  assert.match(background, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(background, /formal_request_not_observed/);
  assert.match(background, /response_evidence_timeout/);
  assert.match(background, /touchRequestResponseWatchdog\(tabId, protocol\?\.requestId/);
  assert.match(network, /event: 'conversation_response_activity'/);
  assert.match(guard, /status = reason === 'formal_request_not_observed'/);
  assert.match(content, /response_timeout: \['响应超时', 'wait'\]/);
});
