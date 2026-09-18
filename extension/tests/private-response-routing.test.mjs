import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPrivateResponsePayload,
  decodePrivateResponseBody,
  hasCompletePrivateResponseEvidence,
  normalizePrivateResponseEvidence,
} from '../private-response-routing.js';

test('private response payload carries raw local evidence without persistence metadata', () => {
  assert.deepEqual(
    buildPrivateResponsePayload({
      body: 'payload',
      headers: { Example: 'value', Numeric: 7 },
      mimeType: 'application/json',
    }),
    {
      body: 'payload',
      headers: { Example: 'value', Numeric: '7' },
      mimeType: 'application/json',
    },
  );
});

test('private response evidence normalizer requires complete conflict-free model and reasoning', () => {
  const evidence = normalizePrivateResponseEvidence({
    model: 'model-a',
    reasoning: 'high',
    conflicts: { model: false, reasoning: false },
    fields: { model: '$.meta.model', reasoning: '$.meta.reasoning' },
    diagnostics: { bodyLength: 42, nested: { sample: true } },
  });
  assert.equal(hasCompletePrivateResponseEvidence(evidence), true);
  assert.equal(hasCompletePrivateResponseEvidence({ ...evidence, reasoning: null }), false);
  assert.equal(hasCompletePrivateResponseEvidence({ ...evidence, conflicts: { model: true, reasoning: false } }), false);
});

test('base64 response decoding uses UTF-8', () => {
  const encoded = btoa(unescape(encodeURIComponent('你好 GPTWork')));
  assert.equal(decodePrivateResponseBody(encoded, true), '你好 GPTWork');
});
