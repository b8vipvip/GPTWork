import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const lifecycle = fs.readFileSync(new URL('../content-runtime-lifecycle.js', import.meta.url), 'utf8');
const contentScript = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');

test('v0.5.124 heavy diagnostic telemetry is armed only for an explicit capture', () => {
  assert.match(lifecycle, /let diagnosticCaptureActive = false/);
  assert.match(lifecycle, /if \(!diagnosticCaptureActive\) return callback\(\.\.\.args\)/);
  assert.match(lifecycle, /function setDiagnosticCaptureActive\(active\)/);
  assert.match(lifecycle, /installInteractionDiagnostics\(\)/);
  assert.match(lifecycle, /installDiagnosticLongTaskObserver\(\)/);
  assert.match(lifecycle, /isDiagnosticCaptureActive/);
  assert.doesNotMatch(lifecycle, /\n  installInteractionDiagnostics\(\);\n  installDiagnosticLongTaskObserver\(\);/);
});

test('v0.5.124 background owns capture lifetime across the causal phase transaction', () => {
  assert.match(background, /captureActive = Boolean\(state\.captureId && state\.label !== 'restore_normal'\)/);
  assert.match(background, /type: 'GPTWORK_DIAGNOSTIC_CONTENT_SUSPEND',[\s\S]*captureActive/);
  assert.match(contentScript, /setDiagnosticCaptureActive\?\.\(captureActive\)/);
  assert.match(contentScript, /setDiagnosticContentSuspended\(message\.suspended, message\.captureActive\)/);
});

test('v0.5.124 removeEventListener preserves DOM capture semantics', () => {
  assert.match(lifecycle, /const capture = typeof options === 'boolean' \? options : options\?\.capture === true/);
  assert.match(lifecycle, /item\.listener === listener[\s\S]*item\.capture === capture/);
  assert.match(lifecycle, /eventListeners\.delete\(record\)/);
});
