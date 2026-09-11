import {
  MODEL_AVAILABILITY_STORAGE_KEY,
  MODEL_SELECTION_KEY,
  MODEL_SELECTION_SEEN_KEY,
  evaluateModelAvailability,
  isHigherThanSol,
  knownHigherModels,
  normalizeAvailabilityState,
  unavailableModelIds,
} from './model-availability.js';
import { DEFAULT_POLICY, normalizeConcreteModelId, normalizePolicy } from './policy.js';

const RUNTIME_LOG_STORAGE_KEY = 'runtimeLogs';
const DISCOVERED_MODELS_KEY = 'discoveredModels';
const DISCOVERED_EVIDENCE_KEY = 'discoveredModelEvidence';
const ASTRA_POLICY_MIGRATION_KEY = 'astraPolicyMigrationV1';
const WORK_MODE_KEY = 'gptworkWorkModeEnabled';
const MODEL_LOCK_KEY = 'gptworkModelLockEnabled';
const SOL_MODEL_ID = 'gpt-5.6-sol';
const ASTRA_MODEL_ID = 'gpt-6-astra';
const MAX_SEEN_LOG_IDS = 1200;

let queue = Promise.resolve();
let bootstrapped = false;
const seenLogIds = new Set();
const autoVerificationTabs = new Set();
const pendingAutoVerificationEvidence = new Map();

function enqueue(task) {
  queue = queue.catch(() => {}).then(task).catch(() => {});
  return queue;
}

function normalizeModels(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeConcreteModelId)
    .filter(Boolean))];
}

function trustedDiscoveredModels(stored) {
  const evidence = stored?.[DISCOVERED_EVIDENCE_KEY] && typeof stored[DISCOVERED_EVIDENCE_KEY] === 'object'
    ? stored[DISCOVERED_EVIDENCE_KEY]
    : {};
  return normalizeModels(stored?.[DISCOVERED_MODELS_KEY]).filter((model) => {
    const sources = Array.isArray(evidence?.[model]?.sources) ? evidence[model].sources : [];
    return sources.includes('network_request_metadata') || sources.includes('network_response_metadata');
  });
}

function seedTrustedAvailability(stateValue, discovered) {
  const state = normalizeAvailabilityState(stateValue);
  const models = { ...state.models };
  let changed = false;
  const now = new Date().toISOString();
  for (const model of discovered.filter(isHigherThanSol)) {
    if (models[model]) continue;
    models[model] = {
      status: 'available',
      checkedAt: now,
      source: 'trusted_model_discovery',
    };
    changed = true;
  }
  return changed ? { ...state, models } : state;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function reconcileSelectionAndPolicy(availabilityValue, { restored = [] } = {}) {
  const [local, synced] = await Promise.all([
    chrome.storage.local.get([WORK_MODE_KEY, MODEL_LOCK_KEY]),
    chrome.storage.sync.get([
      'policy',
      MODEL_SELECTION_KEY,
      MODEL_SELECTION_SEEN_KEY,
      DISCOVERED_MODELS_KEY,
      DISCOVERED_EVIDENCE_KEY,
      ASTRA_POLICY_MIGRATION_KEY,
    ]),
  ]);

  const availability = normalizeAvailabilityState(availabilityValue);
  const unavailable = new Set(unavailableModelIds(availability));
  const discovered = trustedDiscoveredModels(synced);
  const policy = normalizePolicy(synced.policy ?? DEFAULT_POLICY);
  const selectionWasExplicit = Array.isArray(synced[MODEL_SELECTION_KEY]);
  let selection = normalizeModels(selectionWasExplicit ? synced[MODEL_SELECTION_KEY] : policy.lockedModels);
  const seen = new Set(normalizeModels(synced[MODEL_SELECTION_SEEN_KEY]));
  const autoCandidates = [...new Set([
    ...knownHigherModels(),
    ...discovered.filter(isHigherThanSol),
  ])];
  const restoredSet = new Set(normalizeModels(restored));

  // Astra already had a one-shot migration before this availability feature existed.
  // Treat that migration as the initial auto-selection so a user's later manual opt-out
  // is not silently reversed merely because this feature was added.
  if (synced[ASTRA_POLICY_MIGRATION_KEY] === true) seen.add(ASTRA_MODEL_ID);

  for (const model of autoCandidates) {
    if (unavailable.has(model)) continue;
    if (restoredSet.has(model)) {
      if (!selection.includes(model)) selection.push(model);
      seen.add(model);
      continue;
    }
    if (seen.has(model)) continue;
    if (!selection.includes(model)) selection.push(model);
    seen.add(model);
  }

  selection = normalizeModels(selection).filter((model) => !unavailable.has(model));
  if (!selection.length) selection = [SOL_MODEL_ID];

  const syncPatch = {};
  if (!sameJson(normalizeModels(synced[MODEL_SELECTION_KEY]), selection) || !selectionWasExplicit) {
    syncPatch[MODEL_SELECTION_KEY] = selection;
  }
  const nextSeen = [...seen];
  if (!sameJson(normalizeModels(synced[MODEL_SELECTION_SEEN_KEY]), nextSeen)) {
    syncPatch[MODEL_SELECTION_SEEN_KEY] = nextSeen;
  }

  const workModeEnabled = local[WORK_MODE_KEY] === true;
  const modelLockEnabled = local[MODEL_LOCK_KEY] === true;
  if (workModeEnabled || modelLockEnabled) {
    const active = [];
    if (workModeEnabled) {
      active.push(
        ASTRA_MODEL_ID,
        SOL_MODEL_ID,
        ...knownHigherModels(),
        ...discovered.filter((model) => model === SOL_MODEL_ID || isHigherThanSol(model)),
      );
    }
    if (modelLockEnabled) active.push(...selection);
    const lockedModels = normalizeModels(active).filter((model) => !unavailable.has(model));
    if (!lockedModels.length) lockedModels.push(SOL_MODEL_ID);
    if (!sameJson(normalizeModels(policy.lockedModels), lockedModels)) {
      syncPatch.policy = { ...policy, lockedModels };
    }
  }

  if (Object.keys(syncPatch).length) await chrome.storage.sync.set(syncPatch);
}

async function applyAvailabilityProbe(details) {
  const [local, synced] = await Promise.all([
    chrome.storage.local.get(MODEL_AVAILABILITY_STORAGE_KEY),
    chrome.storage.sync.get([DISCOVERED_MODELS_KEY, DISCOVERED_EVIDENCE_KEY]),
  ]);
  const discovered = trustedDiscoveredModels(synced);
  const seeded = seedTrustedAvailability(local[MODEL_AVAILABILITY_STORAGE_KEY], discovered);
  const result = evaluateModelAvailability(seeded, details, discovered);
  if (!result.probed) return;

  if (result.changed || !sameJson(seeded, local[MODEL_AVAILABILITY_STORAGE_KEY])) {
    await chrome.storage.local.set({ [MODEL_AVAILABILITY_STORAGE_KEY]: result.state });
  }
  await reconcileSelectionAndPolicy(result.state, { restored: result.becameAvailable });
}

function rememberLogId(id) {
  if (!id) return;
  seenLogIds.add(id);
  if (seenLogIds.size <= MAX_SEEN_LOG_IDS) return;
  const removeCount = seenLogIds.size - MAX_SEEN_LOG_IDS;
  let removed = 0;
  for (const value of seenLogIds) {
    seenLogIds.delete(value);
    removed += 1;
    if (removed >= removeCount) break;
  }
}

function logIdentity(entry, index = 0) {
  return entry?.id || `${entry?.timestamp || ''}:${entry?.component || ''}:${entry?.event || ''}:${index}`;
}

function processRuntimeLog(entry) {
  if (!entry || entry.component !== 'verification') return;
  const tabId = Number(entry?.details?.tabId);
  if (!Number.isInteger(tabId)) return;

  if (entry.event === 'auto_verify_started') {
    autoVerificationTabs.add(tabId);
    pendingAutoVerificationEvidence.delete(tabId);
    return;
  }

  if (entry.event === 'response_evaluated') {
    const details = entry.details || {};
    if (autoVerificationTabs.has(tabId)) {
      pendingAutoVerificationEvidence.set(tabId, details);
    } else {
      enqueue(() => applyAvailabilityProbe(details));
    }
    return;
  }

  if (entry.event === 'auto_verify_completed') {
    autoVerificationTabs.delete(tabId);
    const pending = pendingAutoVerificationEvidence.get(tabId);
    pendingAutoVerificationEvidence.delete(tabId);
    if (pending) enqueue(() => applyAvailabilityProbe(pending));
  }
}

function processRuntimeLogChanges(logs) {
  const list = Array.isArray(logs) ? logs : [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    const id = logIdentity(entry, index);
    if (seenLogIds.has(id)) continue;
    rememberLogId(id);
    processRuntimeLog(entry);
  }
}

async function bootstrap() {
  const [local, synced] = await Promise.all([
    chrome.storage.local.get([RUNTIME_LOG_STORAGE_KEY, MODEL_AVAILABILITY_STORAGE_KEY]),
    chrome.storage.sync.get([DISCOVERED_MODELS_KEY, DISCOVERED_EVIDENCE_KEY]),
  ]);
  const logs = Array.isArray(local[RUNTIME_LOG_STORAGE_KEY]) ? local[RUNTIME_LOG_STORAGE_KEY] : [];
  for (let index = 0; index < logs.length; index += 1) {
    const entry = logs[index];
    rememberLogId(logIdentity(entry, index));
    if (entry?.component !== 'verification') continue;
    const tabId = Number(entry?.details?.tabId);
    if (!Number.isInteger(tabId)) continue;
    if (entry.event === 'auto_verify_started') autoVerificationTabs.add(tabId);
    if (entry.event === 'auto_verify_completed') autoVerificationTabs.delete(tabId);
  }

  const discovered = trustedDiscoveredModels(synced);
  const seeded = seedTrustedAvailability(local[MODEL_AVAILABILITY_STORAGE_KEY], discovered);
  if (!sameJson(seeded, local[MODEL_AVAILABILITY_STORAGE_KEY])) {
    await chrome.storage.local.set({ [MODEL_AVAILABILITY_STORAGE_KEY]: seeded });
  }
  await reconcileSelectionAndPolicy(seeded);
  bootstrapped = true;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes[RUNTIME_LOG_STORAGE_KEY] && bootstrapped) {
      processRuntimeLogChanges(changes[RUNTIME_LOG_STORAGE_KEY].newValue);
    }
    if (
      changes[MODEL_AVAILABILITY_STORAGE_KEY]
      || changes[WORK_MODE_KEY]
      || changes[MODEL_LOCK_KEY]
    ) {
      const nextAvailability = changes[MODEL_AVAILABILITY_STORAGE_KEY]?.newValue;
      enqueue(async () => {
        const stored = nextAvailability === undefined
          ? await chrome.storage.local.get(MODEL_AVAILABILITY_STORAGE_KEY)
          : { [MODEL_AVAILABILITY_STORAGE_KEY]: nextAvailability };
        await reconcileSelectionAndPolicy(stored[MODEL_AVAILABILITY_STORAGE_KEY]);
      });
    }
    return;
  }

  if (areaName === 'sync' && (
    changes[DISCOVERED_MODELS_KEY]
    || changes[DISCOVERED_EVIDENCE_KEY]
    || changes.policy
    || changes[MODEL_SELECTION_KEY]
  )) {
    enqueue(async () => {
      const stored = await chrome.storage.local.get(MODEL_AVAILABILITY_STORAGE_KEY);
      await reconcileSelectionAndPolicy(stored[MODEL_AVAILABILITY_STORAGE_KEY]);
    });
  }
});

void bootstrap().catch(() => {
  bootstrapped = true;
});
