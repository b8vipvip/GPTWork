import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const collector = fs.readFileSync(new URL('../../tools/windows/GPTWork-Jank-Diagnostic.ps1', import.meta.url), 'utf8');
const analyzer = fs.readFileSync(new URL('../../tools/windows/Analyze-GPTWork-Jank.ps1', import.meta.url), 'utf8');

test('jank collector keeps ETL/raw evidence local and emits a compact upload archive by default', () => {
  assert.match(collector, /IncludeRawArchive/);
  assert.match(collector, /Small upload bundle/);
  assert.match(collector, /intentionally excluded from the default upload bundle/);
  assert.doesNotMatch(collector, /Compress-Archive -Path "\$root\\\*" -DestinationPath "\$root\.zip"/);
  assert.match(collector, /if\(\$IncludeRawArchive\)/);
});

test('local analyzer accepts legacy archives and excludes ETL from the upload package', () => {
  assert.match(analyzer, /Expand-Archive/);
  assert.match(analyzer, /CPUSeconds/);
  assert.match(analyzer, /source-size-report\.csv/);
  assert.match(analyzer, /evidence-top-spikes\.csv/);
  assert.match(analyzer, /timing-outliers\.csv/);
  assert.match(analyzer, /browser-jank\.etl is intentionally NOT copied into the upload bundle/);
  assert.match(analyzer, /GPTWork-Jank-\$stamp-UPLOAD\.zip/);
});

test('collector invokes the analyzer with a deterministic output folder when bundled together', () => {
  assert.match(collector, /Analyze-GPTWork-Jank\.ps1/);
  assert.match(collector, /-OutputBase \$analysisRoot/);
  assert.match(analyzer, /\[string\]\$OutputBase/);
});

test('v0.5.134 collector includes a full-runtime-off causal phase without new production permissions', () => {
  const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const control = fs.readFileSync(new URL('../jank-control.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert(!manifest.permissions.includes('processes'));
  assert.match(control, /'runtime_off'/);
  assert.match(collector, /Label='runtime_off';Mode='runtime_off'/);
  assert.match(collector, /\$phaseMs=\$endMs\/\[double\]\$phasePlan\.Count/);
  assert.match(background, /let diagnosticRuntimeSuspended = false/);
  assert.match(background, /!diagnosticRuntimeSuspended/);
  assert.match(background, /stopBackgroundRuntime\('diagnostic_runtime_off'\)/);
  assert.match(background, /await initializeAfterCurrentTask\(\)/);
  assert.match(background, /runtimeSuspended: runtimeOff/);
});
