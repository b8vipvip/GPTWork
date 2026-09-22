import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const privateHook = fs.readFileSync(new URL('../private-request-hook.js', import.meta.url), 'utf8');
const monitor = fs.readFileSync(new URL('../network-monitor.js', import.meta.url), 'utf8');
const collector = fs.readFileSync(new URL('../../tools/windows/GPTWork-Jank-Diagnostic.ps1', import.meta.url), 'utf8');
const control = fs.readFileSync(new URL('../jank-control.js', import.meta.url), 'utf8');

test('v0.5.125 verification bypasses private normal-policy interception at Fetch boundary', () => {
  assert.match(privateHook, /const terminalVerificationHandler = prototype\.handlePausedRequest/);
  assert.match(privateHook, /this\.verificationTransaction\?\.\(tabId\)/);
  assert.match(privateHook, /verification\?\.model/);
  assert.match(privateHook, /terminalVerificationHandler\.call\(this, tabId, params\)/);
  assert.match(monitor, /authorityKind: 'verification-transaction'/);
  assert.match(monitor, /fetchRequestId: requestId/);
  assert.match(monitor, /verification_request_authority_mismatch/);
});

test('v0.5.125 causal collector does not block its 250ms loop on GPU counters or default WPR', () => {
  assert.match(collector, /\[switch\]\$IncludeEtw/);
  assert.match(collector, /if\(\$IncludeEtw\)/);
  assert.doesNotMatch(collector, /if\(\$sampleGpu\)/);
  assert.match(collector, /Do not call Get-Counter in the causal loop/);
  assert.match(collector, /PhaseAgeMs/);
  assert.match(collector, /PhaseAgeMs -ge 1500/);
});

test('v0.5.125 phase evidence uses downloads API and restores ChatGPT focus', () => {
  assert.match(control, /chrome\.downloads\.download/);
  assert.match(control, /restoreChatFocus/);
  assert.match(control, /lastAccessed/);
  assert.match(control, /chrome\.tabs\.update\(target\.id, \{ active: true \}\)/);
});
