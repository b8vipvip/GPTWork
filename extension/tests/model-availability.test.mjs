import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ACCOUNT_MODEL_CATALOG_SOURCE,
  MODEL_UNAVAILABLE_MESSAGE,
  accountCatalogModelsFromDetails,
  evaluateModelAvailability,
  isHigherThanSol,
  metadataModelsFromDetails,
  normalizeAvailabilityState,
} from '../model-availability.js';

const availabilitySource = await readFile(new URL('../model-availability.js', import.meta.url), 'utf8');
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

test('ordinary Sol response does not mark Astra or future account models unavailable', () => {
  const result = evaluateModelAvailability(null, responseDetails('gpt-5.6-sol'));
  assert.equal(result.probed, true);
  assert.equal(result.state.models['gpt-6-astra'], undefined);
  assert.deepEqual(result.becameUnavailable, []);
});

test('Astra found anywhere in response model metadata is available', () => {
  const details = responseDetails('gpt-5.6-sol', ['gpt-5.6-sol', 'gpt-6-astra']);
  assert.deepEqual(metadataModelsFromDetails(details), ['gpt-5.6-sol', 'gpt-6-astra']);
  const result = evaluateModelAvailability(null, details);
  assert.equal(result.state.models['gpt-6-astra'].status, 'available');
  assert.deepEqual(result.becameAvailable, ['gpt-6-astra']);
});

test('trusted discovery keeps a newly introduced higher model available across unrelated responses', () => {
  const result = evaluateModelAvailability(
    null,
    responseDetails('gpt-5.6-sol'),
    ['gpt-6.1-nova'],
  );
  assert.equal(result.state.models['gpt-6.1-nova'].status, 'available');
  assert.equal(result.state.models['gpt-6.1-nova'].source, 'trusted_model_discovery');
  assert.deepEqual(result.becameUnavailable, []);
});

test('an already confirmed available model is not downgraded by a later unrelated response', () => {
  const first = evaluateModelAvailability(null, responseDetails('gpt-6-astra'));
  const second = evaluateModelAvailability(first.state, responseDetails('gpt-5.6-sol'));
  assert.equal(second.state.models['gpt-6-astra'].status, 'available');
  assert.deepEqual(second.becameUnavailable, []);
});

test('v1 response-derived false unavailability is removed during state migration', () => {
  const migrated = normalizeAvailabilityState({
    version: 1,
    probeCount: 3,
    lastProbeAt: '2026-09-14T00:00:00.000Z',
    models: {
      'gpt-6-astra': {
        status: 'unavailable',
        checkedAt: '2026-09-14T00:00:00.000Z',
        source: 'network_response_metadata',
      },
      'gpt-6.1-nova': {
        status: 'available',
        checkedAt: '2026-09-14T00:00:00.000Z',
        source: 'trusted_model_discovery',
      },
    },
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.models['gpt-6-astra'], undefined);
  assert.equal(migrated.models['gpt-6.1-nova'].status, 'available');
});

test('only an explicit complete account model catalog may mark a higher model unavailable', () => {
  const details = {
    ...responseDetails('gpt-5.6-sol'),
    accountModelCatalog: {
      complete: true,
      models: ['gpt-5.6-sol'],
    },
  };
  assert.deepEqual(accountCatalogModelsFromDetails(details), ['gpt-5.6-sol']);
  const result = evaluateModelAvailability(null, details);
  assert.equal(result.state.models['gpt-6-astra'].status, 'unavailable');
  assert.equal(result.state.models['gpt-6-astra'].source, ACCOUNT_MODEL_CATALOG_SOURCE);
  assert.deepEqual(result.becameUnavailable.sort(), ['gpt-6-astra', 'gpt-6-sol'].sort());
});

test('live trusted metadata restores a model after an older complete catalog excluded it', () => {
  const first = evaluateModelAvailability(null, {
    ...responseDetails('gpt-5.6-sol'),
    accountModelCatalog: {
      complete: true,
      models: ['gpt-5.6-sol'],
    },
  });
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

test('availability logic cannot infer account-level unavailability from response absence', () => {
  assert.match(availabilitySource, /ACCOUNT_MODEL_CATALOG_SOURCE/);
  assert.match(availabilitySource, /catalog\.complete !== true/);
  assert.doesNotMatch(availabilitySource, /else if \(prior !== 'available'\) status = 'unavailable'/);
});

test('runtime waits for auto verification completion and auto-selects newly discovered higher models once', () => {
  assert.match(runtimeSource, /pendingAutoVerificationEvidence/);
  assert.match(runtimeSource, /entry\.event === 'auto_verify_completed'/);
  assert.match(runtimeSource, /MODEL_SELECTION_SEEN_KEY/);
  assert.match(runtimeSource, /discovered\.filter\(isHigherThanSol\)/);
  assert.match(runtimeSource, /models\[model\]\?\.status === 'available'/);
  assert.match(runtimeSource, /selection = normalizeModels\(selection\)\.filter\(\(model\) => !unavailable\.has\(model\)\)/);
});

test('settings gray only explicitly unavailable models and show the requested explanation', () => {
  assert.equal(MODEL_UNAVAILABLE_MESSAGE, '账户可用模型中未识别到该模型');
  assert.match(optionsSource, /model-unavailable/);
  assert.match(optionsSource, /input\.disabled = true/);
  assert.match(optionsSource, /input\.checked = false/);
  assert.match(optionsSource, /data-tooltip-open/);
  assert.match(optionsSource, /MODEL_UNAVAILABLE_MESSAGE/);
  assert.match(settingsShellSource, /import\('\.\/model-availability-options\.js'\)/);
  assert.match(backgroundEntrySource, /model-availability-runtime\.js/);
});
