// v0.5.201: a lost reply port during initial shared Chat navigation must not
// silently skip a model, and must never trigger a duplicate dispatched probe.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const start = background.indexOf('function shouldRetrySharedChatLockReplyLoss(');
const end = background.indexOf('async function verifyAccountCatalogModels(', start);
assert.ok(start >= 0 && end > start, 'pre-probe recovery helper missing');

const fn = vm.runInNewContext(
  background.slice(start, end) + '\nshouldRetrySharedChatLockReplyLoss',
);
const candidate = {
  chatCompatibility: true,
  sharedSessionPrepared: true,
  probeDispatchStarted: false,
  error: 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received',
  retryCount: 0,
};

test('recover exactly once after shared Chat navigation drops a pre-probe reply', () => {
  assert.equal(fn(candidate), true);
  assert.equal(fn({...candidate, retryCount: 1}), false);
  assert.equal(fn({...candidate, error: 'The message port closed before a response was received.'}), true);
  assert.equal(fn({...candidate, error: 'Could not establish connection. Receiving end does not exist.'}), true);
});

test('never retry after a probe may have been sent or the shared session is not ready', () => {
  assert.equal(fn({...candidate, probeDispatchStarted: true}), false);
  assert.equal(fn({...candidate, sharedSessionPrepared: false}), false);
  assert.equal(fn({...candidate, chatCompatibility: false}), false);
  assert.equal(fn({...candidate, error: 'network timeout'}), false);
});

test('the actual catch retries the same catalog item without treating it as a completed negative', () => {
  const verify = background.slice(background.indexOf('async function verifyAccountCatalogModels('),
    background.indexOf('function modelVerificationHistoryRecord('));
  assert.match(verify, /let probeDispatchStarted = false;/);
  assert.match(verify, /probeDispatchStarted = true;\s*const probe = await sendVerificationReasoningProbe/);
  assert.match(verify, /shouldRetrySharedChatLockReplyLoss\(\{/);
  assert.match(verify, /verificationTransactions\.delete\(Number\(tabId\)\);\s*await sleep\(650\);\s*continue;/);
  assert.match(verify, /chat_lock_transient_reply_recovered/);
  // Keep the existing causal rewrite + exact response proof unchanged.
  assert.match(verify, /const effectiveRewrite = liveState\.lastRewrite\?\.changed === true/);
  assert.match(verify, /rawResponseProtocolModel === expectedResponse/);
  assert.match(verify, /verified = Boolean\(requestId && requestConfirmed && responseConfirmed\)/);
});
