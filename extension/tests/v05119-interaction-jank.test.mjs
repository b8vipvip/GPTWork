import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const content = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const lifecycle = fs.readFileSync(new URL('../content-runtime-lifecycle.js', import.meta.url), 'utf8');

test('model picker retries only the same owned element through transient layout movement', () => {
  assert.match(content, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/);
  assert.match(content, /trustedPointer\(element, action/);
  assert.match(content, /if \(!element\?\.isConnected \|\| !visible\(element\)\) return false/);
});

test('performance telemetry records browser interactions without typed values', () => {
  assert.match(lifecycle, /recentUserInteractions/);
  assert.match(lifecycle, /pointerdown.*pointerup.*click.*keydown.*input.*change.*wheel.*scroll/s);
  assert.match(lifecycle, /keyClass = event\.key\?\.length === 1 \? 'printable' : 'control'/);
  assert.doesNotMatch(lifecycle, /recentUserInteractions\.push\([^\n]*(event\.key|event\.data|\.value)/);
});
