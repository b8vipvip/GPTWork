import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildRequestModelHistory } from '../request-history.js';

const settingsHtml = await readFile(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const backgroundSource = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const networkMonitorSource = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');

function log(timestamp, component, event, details = {}, id = null) {
  return { id: id || `${component}:${event}:${timestamp}`, timestamp, component, event, details };
}

test('request history shows discovered, sent and final response models from one evidence chain', () => {
  const rows = buildRequestModelHistory([
    log('2026-09-06T10:00:00.000Z', 'lock', 'request_lock_rewritten', {
      tabId: 7,
      requestId: 'cdp-1',
      changed: true,
      reason: 'model_rewritten',
      modelBefore: 'gpt-5.5',
      modelAfter: 'gpt-5.6-sol',
      transportModelBefore: 'gpt-5.5',
      transportModelAfter: 'gpt-5.6-sol-wm',
    }),
    log('2026-09-06T10:00:00.100Z', 'network', 'formal_conversation_request_detected', {
      tabId: 7,
      requestId: 'cdp-1',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      responseVerificationEnabled: true,
    }, 'request-row-1'),
    log('2026-09-06T10:00:03.000Z', 'verification', 'response_evaluated', {
      tabId: 7,
      requestId: 'cdp-1',
      verdict: 'verified',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      evidenceSource: 'network_response_metadata',
    }),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'request-row-1');
  assert.equal(rows[0].requestId, 'cdp-1');
  assert.equal(rows[0].discoveredModel, 'gpt-5.5');
  assert.equal(rows[0].requestModel, 'gpt-5.6-sol');
  assert.equal(rows[0].finalModel, 'gpt-5.6-sol');
  assert.equal(rows[0].status, 'verified');
  assert.equal(rows[0].evidenceSource, 'network_response_metadata');
});

test('latest request stays waiting while an older unresolved request becomes unconfirmed', () => {
  const rows = buildRequestModelHistory([
    log('2026-09-06T10:00:00.000Z', 'network', 'formal_conversation_request_detected', {
      tabId: 3,
      requestId: 'older-request',
      model: 'gpt-5.6-sol',
      responseVerificationEnabled: true,
    }, 'older'),
    log('2026-09-06T10:00:02.000Z', 'network', 'formal_conversation_request_detected', {
      tabId: 3,
      requestId: 'latest-request',
      model: 'gpt-6-astra',
      responseVerificationEnabled: true,
    }, 'latest'),
  ]);

  assert.equal(rows[0].id, 'latest');
  assert.equal(rows[0].status, 'waiting');
  assert.equal(rows[1].id, 'older');
  assert.equal(rows[1].status, 'unconfirmed');
});

test('responses are correlated by request id even when same-tab responses arrive out of order', () => {
  const rows = buildRequestModelHistory([
    log('2026-09-06T10:00:00.000Z', 'network', 'formal_conversation_request_detected', {
      tabId: 5,
      requestId: 'request-a',
      model: 'gpt-5.6-sol',
      responseVerificationEnabled: true,
    }, 'row-a'),
    log('2026-09-06T10:00:00.100Z', 'network', 'formal_conversation_request_detected', {
      tabId: 5,
      requestId: 'request-b',
      model: 'gpt-6-astra',
      responseVerificationEnabled: true,
    }, 'row-b'),
    log('2026-09-06T10:00:02.000Z', 'verification', 'response_evaluated', {
      tabId: 5,
      requestId: 'request-a',
      verdict: 'verified',
      model: 'gpt-5.6-sol',
      evidenceSource: 'network_response_metadata',
    }),
    log('2026-09-06T10:00:03.000Z', 'verification', 'response_evaluated', {
      tabId: 5,
      requestId: 'request-b',
      verdict: 'verified',
      model: 'gpt-6-astra',
      evidenceSource: 'network_response_metadata',
    }),
  ]);

  const a = rows.find((row) => row.id === 'row-a');
  const b = rows.find((row) => row.id === 'row-b');
  assert.equal(a.finalModel, 'gpt-5.6-sol');
  assert.equal(a.status, 'verified');
  assert.equal(b.finalModel, 'gpt-6-astra');
  assert.equal(b.status, 'verified');
});

test('tabs are projected independently and response model is never guessed when absent', () => {
  const rows = buildRequestModelHistory([
    log('2026-09-06T10:00:00.000Z', 'network', 'formal_conversation_request_detected', {
      tabId: 1,
      requestId: 'tab-1-request',
      model: 'gpt-5.6-sol',
      responseVerificationEnabled: true,
    }, 'tab-1'),
    log('2026-09-06T10:00:00.100Z', 'network', 'formal_conversation_request_detected', {
      tabId: 2,
      requestId: 'tab-2-request',
      model: 'gpt-6-astra',
      responseVerificationEnabled: true,
    }, 'tab-2'),
    log('2026-09-06T10:00:02.000Z', 'verification', 'response_evaluated', {
      tabId: 1,
      requestId: 'tab-1-request',
      verdict: 'unverified',
      model: null,
      evidenceSource: 'network_response_metadata',
      reason: 'model_missing',
    }),
    log('2026-09-06T10:00:02.100Z', 'verification', 'response_evaluated', {
      tabId: 2,
      requestId: 'tab-2-request',
      verdict: 'verified',
      model: 'gpt-6-astra',
      evidenceSource: 'network_response_metadata',
    }),
  ]);

  const tab1 = rows.find((row) => row.id === 'tab-1');
  const tab2 = rows.find((row) => row.id === 'tab-2');
  assert.equal(tab1.finalModel, null);
  assert.equal(tab1.status, 'unverified');
  assert.equal(tab2.finalModel, 'gpt-6-astra');
  assert.equal(tab2.status, 'verified');
});

test('history is newest-first and bounded', () => {
  const logs = [];
  for (let index = 0; index < 8; index += 1) {
    logs.push(log(`2026-09-06T10:00:0${index}.000Z`, 'network', 'formal_conversation_request_detected', {
      tabId: 9,
      requestId: `request-${index}`,
      model: `gpt-test-${index}`,
      responseVerificationEnabled: false,
    }, `row-${index}`));
  }
  const rows = buildRequestModelHistory(logs, { limit: 3 });
  assert.deepEqual(rows.map((row) => row.id), ['row-7', 'row-6', 'row-5']);
  assert(rows.every((row) => row.status === 'request_only'));
});

test('settings UI exposes request history and existing telemetry carries the correlation id', () => {
  assert.match(settingsHtml, /id="requestHistoryBody"/);
  assert.match(settingsHtml, /发现模型/);
  assert.match(settingsHtml, /请求模型/);
  assert.match(settingsHtml, /最终模型/);
  assert.match(settingsHtml, /request-history-options\.js/);
  assert.match(networkMonitorSource, /requestId: params\.networkId \? String\(params\.networkId\) : null/);
  assert.match(backgroundSource, /requestId: request\.requestId/);
  assert.match(backgroundSource, /requestId: evidence\?\.streamContext\?\.initialRequestId \?\? evidence\.requestId \?\? null/);
});
