// [legacy-core-maintenance] v0.5.190 makes page readiness single-authority.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [background, content] = await Promise.all([
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
  readFile(new URL('../content.js', import.meta.url), 'utf8'),
]);

test('content runtime alone owns verification-surface readiness', () => {
  const start = content.indexOf('function verificationSurfaceStatus()');
  const end = content.indexOf('function stayInChatModeButton', start);
  assert.ok(start >= 0 && end > start);
  const block = content.slice(start, end);

  assert.match(block, /const structuralReady = composerReady;/);
  assert.match(block, /const ready = structuralReady && documentVisible;/);
  assert.match(block, /const modelTriggerReady = Boolean\(composerIntelligenceTrigger\(\)\);/);
  assert.doesNotMatch(block, /structuralReady\s*=\s*composerReady\s*&&\s*modelTriggerReady/);
  assert.match(block, /reason: ready/);
});

test('background trusts the page-runtime verdict instead of reconstructing DOM readiness', () => {
  const start = background.indexOf('function verificationSurfaceAccepted');
  const end = background.indexOf('async function createVerificationExecutionTab', start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);

  assert.match(block, /surface\?\.ready === true/);
  assert.match(block, /surface\?\.structuralReady === true/);
  assert.match(block, /verificationSurfaceAccepted\(last, requireVisible\)/);
  assert.doesNotMatch(block, /last\?\.composerReady === true\s*&&/);
  assert.doesNotMatch(block, /last\?\.modelTriggerReady === true/);
});

test('model trigger remains owned by the model-discovery transaction only', () => {
  const start = content.indexOf('async function discoverAccountModelMetadata()');
  const end = content.indexOf('function diagnosticPerformanceSnapshot', start);
  assert.ok(start >= 0 && end > start);
  const block = content.slice(start, end);

  assert.match(block, /const modern = await openModernModelMenu\(\);/);
  assert.match(block, /triggerFound = Boolean\(modern\.trigger\);/);
  assert.match(block, /candidateCount/);
});

test('surface failure diagnostics do not falsely report Native Core disconnected before Core was checked', () => {
  assert.match(background, /let coreCheck = \{ checked: false, connected: null, error: null \};/);
  assert.match(background, /coreChecked: coreCheck\.checked === true/);
  assert.match(background, /coreConnected: coreCheck\.checked \? coreCheck\.connected === true : null/);
});
