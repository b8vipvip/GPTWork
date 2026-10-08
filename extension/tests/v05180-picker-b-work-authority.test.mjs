import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');

test('v0.5.180 Work entry does not wait for chrome tab complete before messaging the SPA', () => {
  const start = background.indexOf('async function enterNativeWorkOnDiscoveryTab');
  const end = background.indexOf('async function waitForNetworkModelEvidence', start);
  assert.ok(start >= 0 && end > start);
  const body = background.slice(start, end);
  assert.match(body, /type: 'GPTLOCK_VERIFY_ENTER_WORK_MODE'/);
  assert.doesNotMatch(body, /if \(tab\.status === 'complete'\) \{\s*const response = await sendTabMessage/);
  assert.match(body, /ensureContentRuntime\(tabId, 'official_work_entry_wait'\)/);
  assert.match(body, /last\.entered \|\| last\.actuated/);
});

test('v0.5.180 Picker-B topology is the authoritative Work-surface proof', () => {
  const start = background.indexOf('async function discoverOfficialWorkModels');
  const end = background.indexOf('async function publishAccountModels', start);
  assert.ok(start >= 0 && end > start);
  const body = background.slice(start, end);
  assert.match(body, /official_work_control_actuated_unconfirmed/);
  assert.match(body, /official_work_surface_confirmed_by_picker_b/);
  assert.match(body, /reason: 'picker_b_topology_confirmed'/);
  assert.match(body, /work_surface_not_confirmed_by_picker_b/);
  assert.match(body, /discovered\?\.pickerMode === 'B'/);
});

test('v0.5.180 recognizes current Work composer semantics without relying on toggle aria state', () => {
  assert.match(content, /function verificationWorkSurfaceEvidence\(\)/);
  assert.match(content, /projectControl/);
  assert.match(content, /companionControl/);
  assert.match(content, /打开桌面应用/);
  assert.match(content, /actuationReason: actuated \? 'work_control_actuated_unconfirmed' : null/);
  assert.match(content, /reason: 'work_control_actuated_unconfirmed'/);
  assert.doesNotMatch(
    content.slice(content.indexOf('async function enterVerificationWorkMode()'), content.indexOf('async function stopStaleGeneration()')),
    /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/,
  );
  assert.match(content, /surfaceEvidence: verificationWorkSurfaceEvidence\(\)/);
});
