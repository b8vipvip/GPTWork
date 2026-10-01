import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { shouldRetryTransientResponse } from '../vendor/modelpro/model-verification.js';

const r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('a confirmed HTTP 200 response metadata conflict gets exactly one bounded verification replay', () => {
  const base = {
    requestConfirmed: true,
    responseConfirmed: false,
    responseHttpStatus: 200,
    responseIssue: 'response_metadata_conflict',
    responseModel: null,
  };
  assert.equal(shouldRetryTransientResponse({ ...base, retryCount: 0 }, { maxRetries: 1 }), true);
  assert.equal(shouldRetryTransientResponse({ ...base, retryCount: 1 }, { maxRetries: 1 }), false);
});

test('model indicator does not present trusted history as the in-flight verification turn', async () => {
  const history = await r('model-status-history.js');
  assert.match(history, /const suppressHistory = state\?\.autoVerification\?\.running === true;/);
  assert.match(history, /const historicalRequest = !suppressHistory && !currentRequest/);
  assert.match(history, /const historicalResponse = !suppressHistory && !currentRequest/);
});

test('private request routing ignores only observed stale Fetch lifecycle continuation errors', async () => {
  const hook = await r('private-request-hook.js');
  assert.match(hook, /function obsoletePausedRequestError\(error\)/);
  assert.match(hook, /Invalid InterceptionId\|Fetch domain is not enabled/);
  assert.match(hook, /if \(obsoletePausedRequestError\(continueError\)\) return;/);
  assert.match(hook, /if \(obsoletePausedRequestError\(initialError\)\) return;/);
  assert.match(hook, /reason: 'private_request_continue_failed'/);
  assert.match(hook, /reason: 'private_request_fail_open_continue_failed'/);
});
