import { KNOWN_MODELS, normalizeConcreteModelId } from './policy.js';

export const MODEL_AVAILABILITY_STORAGE_KEY = 'gptworkModelAvailabilityV1';
export const MODEL_SELECTION_KEY = 'gptworkModelLockSelection';
export const MODEL_SELECTION_SEEN_KEY = 'gptworkHigherModelSelectionSeenV1';
export const MODEL_UNAVAILABLE_MESSAGE = '账户可用模型中未识别到该模型';
export const MODEL_UNAVAILABLE_MESSAGE_EN = 'This model was not recognized in the account model metadata.';
export const ACCOUNT_MODEL_CATALOG_SOURCE = 'account_model_catalog';

// v1 inferred "unavailable" from a normal response that merely used another model.
// v2 makes availability positive-evidence-first and only accepts negative state from
// an explicit, complete account-level model catalog snapshot.
const AVAILABILITY_VERSION = 2;

function normalizeModels(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeConcreteModelId)
    .filter(Boolean))];
}

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

export function accountCatalogModelsFromDetails(details = {}) {
  const catalog = details?.accountModelCatalog ?? details?.diagnostics?.accountModelCatalog;
  if (!catalog || typeof catalog !== 'object' || catalog.complete !== true) return null;

  const values = Array.isArray(catalog.models)
    ? catalog.models
    : Array.isArray(catalog.availableModels)
      ? catalog.availableModels
      : Array.isArray(catalog.availableModelIds)
        ? catalog.availableModelIds
        : [];
  return normalizeModels(values);
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
  const sourceVersion = Math.max(0, Number(source.version || 0));
  const models = {};
  for (const [rawModel, item] of Object.entries(source.models || {})) {
    const model = normalizeConcreteModelId(rawModel);
    const status = item?.status === 'available' || item?.status === 'unavailable'
      ? item.status
      : null;
    if (!model || !status) continue;

    // v1 could manufacture false negatives from an unrelated response. Never carry
    // those forward. In v2, "unavailable" is valid only when it came from a complete
    // account-level catalog, never from request/response absence.
    if (
      status === 'unavailable'
      && (sourceVersion < AVAILABILITY_VERSION || item?.source !== ACCOUNT_MODEL_CATALOG_SOURCE)
    ) {
      continue;
    }

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

export function evaluateModelAvailability(
  previousValue,
  details = {},
  trustedAvailableModels = [],
  now = new Date().toISOString(),
) {
  const previous = normalizeAvailabilityState(previousValue);
  const recognizedModels = metadataModelsFromDetails(details);
  const trustedModels = normalizeModels(trustedAvailableModels);
  const accountCatalog = accountCatalogModelsFromDetails(details);
  const probed = hasMeaningfulModelMetadata(details)
    || accountCatalog !== null
    || trustedModels.length > 0;

  if (!probed) {
    return {
      state: previous,
      changed: false,
      recognizedModels,
      becameUnavailable: [],
      becameAvailable: [],
      probed: false,
    };
  }

  const candidates = [...new Set([
    ...knownHigherModels(),
    ...trustedModels,
    ...(accountCatalog || []),
  ].map(normalizeConcreteModelId).filter((model) => model && isHigherThanSol(model)))];
  const models = { ...previous.models };
  const becameUnavailable = [];
  const becameAvailable = [];

  const markAvailable = (model, source) => {
    const concrete = normalizeConcreteModelId(model);
    if (!concrete || !isHigherThanSol(concrete)) return;
    const prior = previous.models[concrete]?.status || null;
    if (prior !== 'available') becameAvailable.push(concrete);
    models[concrete] = {
      status: 'available',
      checkedAt: now,
      source,
    };
  };

  const markUnavailable = (model) => {
    const concrete = normalizeConcreteModelId(model);
    if (!concrete || !isHigherThanSol(concrete)) return;
    const prior = previous.models[concrete]?.status || null;
    if (prior !== 'unavailable') becameUnavailable.push(concrete);
    models[concrete] = {
      status: 'unavailable',
      checkedAt: now,
      source: ACCOUNT_MODEL_CATALOG_SOURCE,
    };
  };

  // Any trusted formal request/response discovery is direct positive evidence that
  // the account can expose the model. This is intentionally monotonic across ordinary
  // unrelated responses so a Sol response can never gray Astra (or a future model).
  for (const model of trustedModels) markAvailable(model, 'trusted_model_discovery');
  for (const model of accountCatalog || []) markAvailable(model, ACCOUNT_MODEL_CATALOG_SOURCE);
  for (const model of recognizedModels) markAvailable(model, 'network_response_metadata');

  // Negative availability requires an explicit COMPLETE account catalog. Absence from
  // a normal chat response proves only which model served that request, not which
  // models the account owns. Live trusted evidence wins over a stale catalog snapshot.
  if (accountCatalog !== null) {
    const catalogSet = new Set(accountCatalog);
    const livePositive = new Set([...trustedModels, ...recognizedModels]);
    for (const model of candidates) {
      if (catalogSet.has(model) || livePositive.has(model)) continue;
      markUnavailable(model);
    }
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
