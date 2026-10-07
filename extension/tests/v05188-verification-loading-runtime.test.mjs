// [legacy-core-maintenance] v0.5.188 lets only verification-owned temporary tabs recover while loading.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [background, recovery] = await Promise.all([
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
  readFile(new URL('../content-runtime-recovery.js', import.meta.url), 'utf8'),
]);

test('normal content recovery remains complete-only while verification gets an explicit loading-safe entry point', () => {
  assert.match(recovery, /currentRecoverableTab\(tabId, \{ allowLoading = false \} = \{\}\)/);
  assert.match(recovery, /tab\.status === 'loading' && !allowLoading/);
  assert.match(recovery, /export async function ensureContentRuntime\(tabId, reason = 'unspecified'\)/);
  assert.match(recovery, /allowLoading: false/);
  assert.match(recovery, /export async function ensureContentRuntimeDuringLoad/);
  assert.match(recovery, /allowLoading: true/);
  assert.match(recovery, /loading-ok/);
  assert.match(recovery, /complete-only/);
});

test('verification surface retries targeted injection before chrome tab completion', () => {
  const start = background.indexOf('async function waitForVerificationSurface');
  const end = background.indexOf('async function createVerificationExecutionTab', start);
  const body = background.slice(start, end);
  assert.match(body, /tab\.status === 'loading'/);
  assert.match(body, /loadingRecoveryAttempts < 3/);
  assert.match(body, /ensureContentRuntimeDuringLoad/);
  assert.match(body, /verification_surface_loading_recovery/);
  assert.match(body, /verification_surface_loading_/);
  assert.match(body, /ensureContentRuntime\(tabId, 'verification_surface_wait'\)/);
});

test('official Work entry uses the same loading-safe recovery path', () => {
  const start = background.indexOf('async function enterNativeWorkOnDiscoveryTab');
  const end = background.indexOf('function successfulConversationResponseEvidence', start);
  const body = background.slice(start, end);
  assert.match(body, /tab\.status === 'loading'/);
  assert.match(body, /ensureContentRuntimeDuringLoad/);
  assert.match(body, /official_work_entry_loading_/);
  assert.match(body, /official_work_loading_recovery/);
  assert.match(body, /ensureContentRuntime\(tabId, 'official_work_entry_wait'\)/);
});
