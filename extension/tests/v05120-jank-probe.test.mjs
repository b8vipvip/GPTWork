import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../../tools/windows/GPTWork-Jank-Diagnostic.ps1', import.meta.url), 'utf8');

test('v0.5.120 jank probe avoids the old high-cost key scan and names hot threads', () => {
  assert.match(script, /GetLastInputInfo/);
  assert.match(script, /GetThreadDescription/);
  assert.match(script, /ThreadName=\$threadName/);
  assert.doesNotMatch(script, /foreach\(\$vk in 8\.\.254\)/);
});

test('v0.5.120 jank probe measures its own cadence and slows expensive samplers', () => {
  assert.match(script, /sampleThreads=.*1000/);
  assert.match(script, /sampleGpu=.*2000/);
  assert.match(script, /capture-timing\.csv/);
  assert.match(script, /capture-health\.txt/);
  assert.match(script, /IntervalsOver150Percent/);
  assert.match(script, /top-processes\.csv/);
  assert.match(script, /analysis-summary\.txt/);
});
