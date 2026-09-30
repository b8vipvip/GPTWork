import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { rewriteConversationPostData } from '../network-evidence.js';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('Work bootstrap forces its effective Work model through verificationTransactions', () => {
  const start = background.indexOf('function beginWorkBootstrapTransaction(tabId, source) {');
  const end = background.indexOf('function endWorkBootstrapTransaction', start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);
  assert.match(block, /const model = workBootstrapModelForTab\(normalizedTabId\)/);
  assert.match(block, /verificationTransactions\.set\(normalizedTabId/);
  assert.match(block, /kind: 'work-bootstrap'/);
  assert.match(block, /return \{ previous, model \}/);
});

test('forced Work bootstrap model is converted to its Work transport even when the visible Chat model is known', () => {
  const rewritten = rewriteConversationPostData(JSON.stringify({
    model: 'gpt-5.6-sol',
    thinking_effort: 'high',
  }), {
    lockedModels: ['gpt-6-astra'],
    knownModels: ['gpt-5.6-sol', 'gpt-6-astra'],
    forceModel: 'gpt-6-astra',
    preserveModel: false,
    preserveReasoning: true,
    allowedReasoningLevels: ['high'],
  });
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.modelBefore, 'gpt-5.6-sol');
  assert.equal(rewritten.modelAfter, 'gpt-6-astra');
  assert.equal(rewritten.transportModelAfter, 'gpt-6-astra-wm');
  assert.equal(rewritten.reason, 'verification_model_forced');
});
