import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const diagnosticsHtml = await readFile(new URL('../diagnostics.html', import.meta.url), 'utf8');
const diagnosticsSource = await readFile(new URL('../diagnostics.js', import.meta.url), 'utf8');
const backgroundSource = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('diagnostics export defaults to and supports the recent 300-entry window', () => {
  assert.match(diagnosticsHtml, /id="exportLimit"/);
  assert.match(diagnosticsHtml, /<option value="300" selected>最近 300 条<\/option>/);
  assert.match(diagnosticsSource, /GPTLOCK_EXPORT_DIAGNOSTICS', entryLimit/);
  assert.match(backgroundSource, /Math\.min\(300, Math\.max\(1, Math\.trunc\(parsed\)\)\)/);
  assert.match(backgroundSource, /allRuntimeLogs\.slice\(-limit\)/);
  assert.match(backgroundSource, /sendNative\('get_diagnostics', \{ auditLimit: limit \}\)/);
  assert.match(backgroundSource, /exportSelection:/);
});
