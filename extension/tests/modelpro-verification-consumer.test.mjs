import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVerificationProbe,
  createVerificationCatalog,
  summarizeVerificationOutcome,
} from '../vendor/modelpro/model-verification.js';

test('vendored ModelPro probe keeps deterministic verification contract', () => {
  assert.equal(buildVerificationProbe('GPTWork 模型验证', 2, 7).expectedValue, (134 * 41) + 21);
});

test('vendored ModelPro keeps GPT-5.5 first and supports growing catalog', () => {
  const catalog = createVerificationCatalog({ normalizeModel: (v) => v || null });
  catalog.merge({rows:[{model:'gpt-5.6-sol'},{model:'gpt-5.5'}],pickerMode:'A'}, 'initial');
  assert.deepEqual(catalog.queue.map((x)=>x.model), ['gpt-5.5','gpt-5.6-sol']);
  catalog.merge({rows:[{model:'gpt-6-astra'}],pickerMode:'B'}, 'post-turn');
  assert.equal(catalog.progress.total, 3);
  assert.equal(summarizeVerificationOutcome({total:3,verified:3,failed:0,requestConfirmed:3}).outcome, 'verified');
});
