import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const lifecycle = fs.readFileSync(new URL('../content-runtime-lifecycle.js', import.meta.url), 'utf8');
const content = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const control = fs.readFileSync(new URL('../jank-control.js', import.meta.url), 'utf8');
const collector = fs.readFileSync(new URL('../../tools/windows/GPTWork-Jank-Diagnostic.ps1', import.meta.url), 'utf8');
const analyzer = fs.readFileSync(new URL('../../tools/windows/Analyze-GPTWork-Jank.ps1', import.meta.url), 'utf8');
const monitor = fs.readFileSync(new URL('../network-monitor.js', import.meta.url), 'utf8');

test('v0.5.123 content-off has one lifecycle authority while the diagnostic control plane stays alive', () => {
  assert.match(lifecycle, /function setDiagnosticSuspended/);
  assert.match(lifecycle, /DIAGNOSTIC_CONTROL_MESSAGES/);
  assert.match(lifecycle, /GPTWORK_DIAGNOSTIC_CONTENT_SUSPEND/);
  assert.match(lifecycle, /if \(diagnosticSuspended\) return undefined/);
  assert.match(content, /lifecycle\?\.setDiagnosticSuspended\?\.\(next, 'background-jank-isolation'\)/);
  assert.match(content, /sole callback\/timer\/observer/);
  assert.doesNotMatch(content, /if \(globalThis\.__GPTWORK_DIAGNOSTIC_CONTENT_SUSPENDED__ === true\) return;/);
});

test('v0.5.123 keeps a constant out-of-band Long Task observer across content-off phases', () => {
  assert.match(lifecycle, /new original\.PerformanceObserver/);
  assert.match(lifecycle, /diagnosticLongTaskCount/);
  assert.match(lifecycle, /diagnosticMaxLongTaskMs/);
  assert.match(content, /GPTWORK_DIAGNOSTIC_PERF_SNAPSHOT/);
  assert.match(content, /resetDiagnosticLongTasks: reset/);
});

test('v0.5.123 snapshots the completed phase before changing isolation state', () => {
  assert.match(background, /collectJankPhaseSnapshot\(previous/);
  assert.match(background, /jank_phase_snapshot/);
  assert.match(background, /completedPhase/);
  assert.match(background, /captureId/);
  assert.match(control, /downloadSnapshot/);
  assert.match(control, /GPTWork-Jank-Phase-/);
});

test('v0.5.123 collector and analyzer preserve causal phase page evidence in the small upload bundle', () => {
  assert.match(collector, /phase-page-snapshots\.txt/);
  assert.match(collector, /GPTWork-Jank-Phase-\$captureId-\*\.json/);
  assert.match(collector, /label=\$\(\[uri\]::EscapeDataString\(\$label\)\)/);
  assert.match(analyzer, /phase-page-jank-summary\.csv/);
  assert.match(analyzer, /phase-causality-matrix\.csv/);
  assert.match(analyzer, /do not decide from one metric alone/);
});

test('v0.5.123 retains the verified request and served-model lineage fixes from v0.5.120-v0.5.121', () => {
  assert.match(monitor, /authorityKind: 'verification-transaction'/);
  assert.match(monitor, /Fetch\.requestPaused is the terminal request-mutation boundary/);
  assert.match(monitor, /function isConversationMetadataEndpoint/);
  assert.match(monitor, /path === '\/backend-api\/conversations'/);
});
