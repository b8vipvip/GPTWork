import { KNOWN_MODELS, normalizeConcreteModelId } from './policy.js';

export const MODEL_AVAILABILITY_STORAGE_KEY = 'gptworkModelAvailabilityV1';
export const MODEL_SELECTION_KEY = 'gptworkModelLockSelection';
export const MODEL_SELECTION_SEEN_KEY = 'gptworkHigherModelSelectionSeenV1';
export const MODEL_UNAVAILABLE_MESSAGE = '账户可用模型中未识别到该模型';
export const MODEL_UNAVAILABLE_MESSAGE_EN = 'This model was not recognized in the account model metadata.';

const AVAILABILITY_VERSION = 1;

export function isHigherThanSol(value) {
  const model = normalizeConcreteModelId(value);
  if (!model) return false;
  if (model === 'gpt-6-astra') return true;
  const match = model.match(/^gpt-(\d+)(?:[.-](\d+))?/i);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] || 0);
  return major > 5 || (major === 5 && minor > 6);
}

export function knownHigherModels() {
  return [...new Set(KNOWN_MODELS
    .map((item) => normalizeConcreteModelId(item?.id))
    .filter((model) => model && isHigherThanSol(model)))];
}

export function metadataModelsFromDetails(details = {}) {
  const candidates = [
    details?.model,
    ...(Array.isArray(details?.diagnostics?.modelCandidateValues)
      ? details.diagnostics.modelCandidateValues
      : []),
  ];
  return [...new Set(candidates.map(normalizeConcreteModelId).filter(Boolean))];
}

export function hasMeaningfulModelMetadata(details = {}) {
  const diagnostics = details?.diagnostics || {};
  return Boolean(
    normalizeConcreteModelId(details?.model)
      || Number(diagnostics.modelCandidateCount || 0) > 0
      || Number(diagnostics.parsedObjectCount || 0) > 0
      || (Array.isArray(diagnostics.matchedHeaderFields) && diagnostics.matchedHeaderFields.length > 0),
  );
}

export function normalizeAvailabilityState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const models = {};
  for (const [rawModel, item] of Object.entries(source.models || {})) {
    const model = normalizeConcreteModelId(rawModel);
    const status = item?.status === 'available' || item?.status === 'unavailable'
      ? item.status
      : null;
    if (!model || !status) continue;
    models[model] = {
      status,
      checkedAt: typeof item.checkedAt === 'string' ? item.checkedAt : null,
      source: typeof item.source === 'string' ? item.source : null,
    };
  }
  return {
    version: AVAILABILITY_VERSION,
    probeCount: Math.max(0, Number(source.probeCount || 0)),
    lastProbeAt: typeof source.lastProbeAt === 'string' ? source.lastProbeAt : null,
    models,
  };
}

export function unavailableModelIds(state) {
  const normalized = normalizeAvailabilityState(state);
  return Object.entries(normalized.models)
    .filter(([, item]) => item.status === 'unavailable')
    .map(([model]) => model);
}

export function evaluateModelAvailability(previousValue, details = {}, extraCandidates = [], now = new Date().toISOString()) {
  const previous = normalizeAvailabilityState(previousValue);
  if (!hasMeaningfulModelMetadata(details)) {
    return {
      state: previous,
      changed: false,
      recognizedModels: metadataModelsFromDetails(details),
      becameUnavailable: [],
      becameAvailable: [],
      probed: false,
    };
  }

  const recognizedModels = metadataModelsFromDetails(details);
  const recognized = new Set(recognizedModels);
  const candidates = [...new Set([
    ...knownHigherModels(),
    ...(Array.isArray(extraCandidates) ? extraCandidates : []),
  ].map(normalizeConcreteModelId).filter((model) => model && isHigherThanSol(model)))];
  const models = { ...previous.models };
  const becameUnavailable = [];
  const becameAvailable = [];

  for (const model of candidates) {
    const prior = previous.models[model]?.status || null;
    let status = prior;
    if (recognized.has(model)) status = 'available';
    else if (prior !== 'available') status = 'unavailable';

    if (!status) continue;
    if (prior !== status) {
      if (status === 'available') becameAvailable.push(model);
      if (status === 'unavailable') becameUnavailable.push(model);
    }
    models[model] = {
      status,
      checkedAt: now,
      source: 'network_response_metadata',
    };
  }

  for (const model of recognizedModels.filter(isHigherThanSol)) {
    const prior = previous.models[model]?.status || null;
    if (prior !== 'available') becameAvailable.push(model);
    models[model] = {
      status: 'available',
      checkedAt: now,
      source: 'network_response_metadata',
    };
  }

  const state = {
    version: AVAILABILITY_VERSION,
    probeCount: previous.probeCount + 1,
    lastProbeAt: now,
    models,
  };
  return {
    state,
    changed: JSON.stringify(state) !== JSON.stringify(previous),
    recognizedModels,
    becameUnavailable: [...new Set(becameUnavailable)],
    becameAvailable: [...new Set(becameAvailable)],
    probed: true,
  };
}
