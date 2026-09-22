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
