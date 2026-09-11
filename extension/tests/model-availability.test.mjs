import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  MODEL_UNAVAILABLE_MESSAGE,
  evaluateModelAvailability,
  isHigherThanSol,
  metadataModelsFromDetails,
} from '../model-availability.js';

const runtimeSource = await readFile(new URL('../model-availability-runtime.js', import.meta.url), 'utf8');
const optionsSource = await readFile(new URL('../model-availability-options.js', import.meta.url), 'utf8');
const settingsShellSource = await readFile(new URL('../settings-shell.js', import.meta.url), 'utf8');
const backgroundEntrySource = await readFile(new URL('../background-entry.js', import.meta.url), 'utf8');

function responseDetails(model, candidateValues = [model].filter(Boolean), overrides = {}) {
  return {
    model,
    diagnostics: {
      parsedObjectCount: 1,
      modelCandidateCount: candidateValues.length,
      modelCandidateValues: candidateValues,
      matchedHeaderFields: [],
      ...overrides,
    },
  };
}

test('Astra and future higher GPT models are treated as optimistic higher models', () => {
  assert.equal(isHigherThanSol('gpt-6-astra'), true);
  assert.equal(isHigherThanSol('gpt-6.1-nova'), true);
  assert.equal(isHigherThanSol('gpt-5.7-preview'), true);
  assert.equal(isHigherThanSol('gpt-5.6-sol'), false);
  assert.equal(isHigherThanSol('gpt-5.5'), false);
});

test('first meaningful response metadata without Astra marks it unavailable', () => {
  const result = evaluateModelAvailability(null, responseDetails('gpt-5.6-sol'));
  assert.equal(result.probed, true);
  assert.equal(result.state.models['gpt-6-astra'].status, 'unavailable');
  assert.deepEqual(result.becameUnavailable, ['gpt-6-astra']);
});

test('Astra found anywhere in response model metadata is available', () => {
  const details = responseDetails('gpt-5.6-sol', ['gpt-5.6-sol', 'gpt-6-astra']);
  assert.deepEqual(metadataModelsFromDetails(details), ['gpt-5.6-sol', 'gpt-6-astra']);
  const result = evaluateModelAvailability(null, details);
  assert.equal(result.state.models['gpt-6-astra'].status, 'available');
  assert.deepEqual(result.becameAvailable, ['gpt-6-astra']);
});

test('an already confirmed available model is not downgraded by a later unrelated response', () => {
  const first = evaluateModelAvailability(null, responseDetails('gpt-6-astra'));
  const second = evaluateModelAvailability(first.state, responseDetails('gpt-5.6-sol'));
  assert.equal(second.state.models['gpt-6-astra'].status, 'available');
  assert.deepEqual(second.becameUnavailable, []);
});

test('a later metadata recognition restores a model that was previously unavailable', () => {
  const first = evaluateModelAvailability(null, responseDetails('gpt-5.6-sol'));
  const second = evaluateModelAvailability(first.state, responseDetails('gpt-6-astra'));
  assert.equal(second.state.models['gpt-6-astra'].status, 'available');
  assert.deepEqual(second.becameAvailable, ['gpt-6-astra']);
});

test('technical response failures without parsed model metadata do not gray optimistic models', () => {
  const result = evaluateModelAvailability(null, {
    model: null,
    diagnostics: {
      parsedObjectCount: 0,
      modelCandidateCount: 0,
      modelCandidateValues: [],
      matchedHeaderFields: [],
      bodyFormat: 'unparsed',
    },
  });
  assert.equal(result.probed, false);
  assert.equal(result.state.models['gpt-6-astra'], undefined);
});

test('runtime waits for auto verification completion and auto-selects newly discovered higher models once', () => {
  assert.match(runtimeSource, /pendingAutoVerificationEvidence/);
  assert.match(runtimeSource, /entry\.event === 'auto_verify_completed'/);
  assert.match(runtimeSource, /MODEL_SELECTION_SEEN_KEY/);
  assert.match(runtimeSource, /discovered\.filter\(isHigherThanSol\)/);
  assert.match(runtimeSource, /selection = normalizeModels\(selection\)\.filter\(\(model\) => !unavailable\.has\(model\)\)/);
});

test('settings gray unavailable models and show the requested hover or click explanation', () => {
  assert.equal(MODEL_UNAVAILABLE_MESSAGE, '账户可用模型中未识别到该模型');
  assert.match(optionsSource, /model-unavailable/);
  assert.match(optionsSource, /input\.disabled = true/);
  assert.match(optionsSource, /input\.checked = false/);
  assert.match(optionsSource, /data-tooltip-open/);
  assert.match(optionsSource, /MODEL_UNAVAILABLE_MESSAGE/);
  assert.match(settingsShellSource, /import\('\.\/model-availability-options\.js'\)/);
  assert.match(backgroundEntrySource, /model-availability-runtime\.js/);
});
