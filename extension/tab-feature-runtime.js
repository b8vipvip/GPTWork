import { normalizeConcreteModelId, normalizePolicy } from './policy.js';
import { appendRuntimeLog } from './runtime-log.js';
import { scheduleAccountRefresh } from './account-refresh-scheduler.js';

export const WINDOW_FEATURE_SESSION_KEY = 'gptworkWindowFeatureStatesV1';
export const TAB_FEATURE_SESSION_KEY = 'gptworkTabFeatureStatesV1';
export const TAB_FEATURE_MIGRATION_KEY = 'gptworkTabFeatureMigrationV1';
export const LEGACY_WORK_MODE_KEY = 'gptworkWorkModeEnabled';
export const LEGACY_MODEL_LOCK_KEY = 'gptworkModelLockEnabled';
export const MASTER_KEY = 'gptworkEnabledLocal';
export const WINDOW_QUOTA_MESSAGE = '当前账户并发窗口超限';

const MODEL_SELECTION_KEY = 'gptworkModelLockSelection';
const DISCOVERED_MODELS_KEY = 'discoveredModels';
const BASE_WORK_MODELS = Object.freeze(['gpt-6-astra', 'gpt-5.6-sol']);
const FEATURE_MESSAGE_TYPES = new Set([
  'GPTWORK_TAB_FEATURE_GET',
  'GPTWORK_TAB_FEATURE_SET',
  'GPTWORK_MASTER_STATUS',
  'GPTWORK_MASTER_SET',
]);

// Feature authority is window-scoped. tabWindowIds is only a routing cache so
// existing tab-oriented message APIs remain backward compatible.
const states = new Map();
const tabWindowIds = new Map();
let basePolicy = normalizePolicy(null);
let modelLockSelection = [];
let discoveredModels = [];
let masterEnabled = false;
let initialized = false;
let initializePromise = null;
let selectionWriteInFlight = false;

function log(event, details = {}, level = 'info') {
  void appendRuntimeLog(level, 'tab-feature', event, details).catch(() => {});
}

function normalizeState(value) {
  return {
    workModeEnabled: value?.workModeEnabled === true,
    modelLockEnabled: value?.modelLockEnabled === true,
  };
}

function normalizeModels(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeConcreteModelId)
    .filter(Boolean))];
}

function sameModels(left, right) {
  return JSON.stringify(normalizeModels(left)) === JSON.stringify(normalizeModels(right));
}

function isAtLeastSol(model) {
  const normalized = normalizeConcreteModelId(model);
  if (!normalized) return false;
  if (normalized === 'gpt-6-astra' || normalized === 'gpt-5.6-sol') return true;
  const match = normalized.match(/^gpt-(\d+)(?:[.-](\d+))?/i);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] || 0);
  return major > 5 || (major === 5 && minor >= 6);
}

function workModels() {
  return [...new Set([
    ...BASE_WORK_MODELS,
    ...normalizeModels(discoveredModels).filter(isAtLeastSol),
  ])];
}

function rememberTabWindow(tab) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) return null;
  tabWindowIds.set(tab.id, tab.windowId);
  return tab.windowId;
}

export async function resolveWindowIdForTab(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return null;
  const cached = tabWindowIds.get(id);
  if (Number.isInteger(cached)) return cached;
  try {
    const tab = await chrome.tabs.get(id);
    return rememberTabWindow(tab);
  } catch {
    return null;
  }
}

function serializedStates() {
  return Object.fromEntries([...states.entries()].map(([windowId, value]) => [String(windowId), normalizeState(value)]));
}

async function persistStates() {
  await chrome.storage.session.set({ [WINDOW_FEATURE_SESSION_KEY]: serializedStates() });
}

async function migrateLegacyTabSession(legacyMap, tabs) {
  if (!legacyMap || typeof legacyMap !== 'object') return 0;
  let migratedWindows = 0;
  const orderedTabs = [...tabs].sort((left, right) => {
    if (Boolean(right.active) !== Boolean(left.active)) return Number(right.active) - Number(left.active);
    return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
  });
  for (const tab of orderedTabs) {
    if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) continue;
    if (states.has(tab.windowId)) continue;
    const legacyState = legacyMap[String(tab.id)];
    if (!legacyState || typeof legacyState !== 'object') continue;
    states.set(tab.windowId, normalizeState(legacyState));
    migratedWindows += 1;
  }
  if (migratedWindows > 0) await persistStates();
  try { await chrome.storage.session.remove(TAB_FEATURE_SESSION_KEY); } catch {}
  log('tab_session_migrated_to_windows', { migratedWindows });
  return migratedWindows;
}

async function migrateLegacyFlags(storedLocal, tabs) {
  if (storedLocal[TAB_FEATURE_MIGRATION_KEY] === true) return;
  const legacy = normalizeState({
    workModeEnabled: storedLocal[LEGACY_WORK_MODE_KEY] === true,
    modelLockEnabled: storedLocal[LEGACY_MODEL_LOCK_KEY] === true,
  });
  if (legacy.workModeEnabled || legacy.modelLockEnabled) {
    const windowIds = new Set(tabs
      .map((tab) => Number(tab?.windowId))
      .filter(Number.isInteger));
    for (const windowId of windowIds) {
      if (!states.has(windowId)) states.set(windowId, legacy);
    }
    await persistStates();
  }
  await chrome.storage.local.set({
    [TAB_FEATURE_MIGRATION_KEY]: true,
    [LEGACY_WORK_MODE_KEY]: false,
    [LEGACY_MODEL_LOCK_KEY]: false,
  });
  log('legacy_feature_flags_migrated', {
    workModeEnabled: legacy.workModeEnabled,
    modelLockEnabled: legacy.modelLockEnabled,
    migratedWindowCount: states.size,
  });
}

async function restoreExplicitModelSelectionForMigration(storedLocal) {
  if (storedLocal[TAB_FEATURE_MIGRATION_KEY] === true || !modelLockSelection.length) return;
  if (sameModels(basePolicy.lockedModels, modelLockSelection)) return;
  basePolicy = normalizePolicy({ ...basePolicy, lockedModels: modelLockSelection });
  selectionWriteInFlight = true;
  try {
    await chrome.storage.sync.set({ policy: basePolicy });
    log('legacy_model_selection_restored', { lockedModels: modelLockSelection });
  } finally {
    selectionWriteInFlight = false;
  }
}

export async function initializeTabFeatureRuntime() {
  if (initialized) return;
  if (initializePromise) return initializePromise;
  initializePromise = (async () => {
    const [sessionStored, localStored, syncStored, tabs] = await Promise.all([
      chrome.storage.session.get([WINDOW_FEATURE_SESSION_KEY, TAB_FEATURE_SESSION_KEY]),
      chrome.storage.local.get([
        TAB_FEATURE_MIGRATION_KEY,
        LEGACY_WORK_MODE_KEY,
        LEGACY_MODEL_LOCK_KEY,
        MASTER_KEY,
      ]),
      chrome.storage.sync.get(['policy', MODEL_SELECTION_KEY, DISCOVERED_MODELS_KEY]),
      chrome.tabs.query({ url: 'https://chatgpt.com/*' }),
    ]);

    for (const tab of tabs) rememberTabWindow(tab);

    const windowMap = sessionStored[WINDOW_FEATURE_SESSION_KEY];
    if (windowMap && typeof windowMap === 'object') {
      for (const [key, value] of Object.entries(windowMap)) {
        const windowId = Number(key);
        if (Number.isInteger(windowId)) states.set(windowId, normalizeState(value));
      }
    }

    await migrateLegacyTabSession(sessionStored[TAB_FEATURE_SESSION_KEY], tabs);
    basePolicy = normalizePolicy(syncStored.policy);
    modelLockSelection = normalizeModels(syncStored[MODEL_SELECTION_KEY]);
    discoveredModels = normalizeModels(syncStored[DISCOVERED_MODELS_KEY]);
    masterEnabled = localStored[MASTER_KEY] === true;
    await restoreExplicitModelSelectionForMigration(localStored);
    await migrateLegacyFlags(localStored, tabs);
    initialized = true;
  })().finally(() => {
    initializePromise = null;
  });
  return initializePromise;
}

export function tabFeatureStateSync(tabId) {
  const windowId = tabWindowIds.get(Number(tabId));
  if (!Number.isInteger(windowId)) return normalizeState(null);
  return normalizeState(states.get(windowId));
}

export async function getTabFeatureState(tabId) {
  await initializeTabFeatureRuntime();
  const windowId = await resolveWindowIdForTab(tabId);
  return Number.isInteger(windowId) ? normalizeState(states.get(windowId)) : normalizeState(null);
}

export function tabFeatureEnabledSync(tabId) {
  if (!masterEnabled) return false;
  const state = tabFeatureStateSync(tabId);
  return state.workModeEnabled || state.modelLockEnabled;
}

export function effectivePolicyForTabSync(tabId) {
  const feature = masterEnabled ? tabFeatureStateSync(tabId) : normalizeState(null);
  const active = [];
  if (feature.workModeEnabled) active.push(...workModels());
  if (feature.modelLockEnabled) {
    active.push(...(modelLockSelection.length ? modelLockSelection : normalizeModels(basePolicy.lockedModels)));
  }
  return normalizePolicy({
    ...basePolicy,
    lockedModels: active.length ? [...new Set(active)] : basePolicy.lockedModels,
  });
}

export function lockConfigurationForTabSync(tabId, fallback = {}) {
  const policy = effectivePolicyForTabSync(tabId);
  return {
    ...fallback,
    lockedModels: policy.lockedModels,
    allowedReasoningLevels: policy.allowedReasoningLevels,
  };
}

async function setTabFeatureState(tabId, patch) {
  await initializeTabFeatureRuntime();
  const id = Number(tabId);
  if (!Number.isInteger(id)) throw Object.assign(new Error('没有打开的 ChatGPT 标签页'), { code: 'NO_CHATGPT_TAB' });
  const windowId = await resolveWindowIdForTab(id);
  if (!Number.isInteger(windowId)) throw Object.assign(new Error('无法确定 ChatGPT 所在窗口'), { code: 'NO_CHATGPT_WINDOW' });
  const next = normalizeState({ ...states.get(windowId), ...patch });
  states.set(windowId, next);
  await persistStates();
  log('window_feature_changed', { tabId: id, windowId, ...next });
  return next;
}

async function removeTabState(tabId) {
  tabWindowIds.delete(Number(tabId));
}

async function removeWindowState(windowId) {
  await initializeTabFeatureRuntime();
  const id = Number(windowId);
  if (!Number.isInteger(id)) return;
  let changed = states.delete(id);
  for (const [tabId, rememberedWindowId] of tabWindowIds.entries()) {
    if (rememberedWindowId === id) tabWindowIds.delete(tabId);
  }
  if (changed) await persistStates();
  log('window_feature_removed', { windowId: id, changed });
}

function isChatGptUrl(value) {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}

async function targetTabId(preferred = null, sender = null) {
  if (Number.isInteger(preferred)) {
    try {
      const tab = await chrome.tabs.get(preferred);
      if (isChatGptUrl(tab?.url)) {
        rememberTabWindow(tab);
        return preferred;
      }
    } catch {}
  }
  if (Number.isInteger(sender?.tab?.id) && isChatGptUrl(sender.tab.url)) {
    rememberTabWindow(sender.tab);
    return sender.tab.id;
  }
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  tabs.forEach(rememberTabWindow);
  tabs.sort((left, right) => {
    if (Boolean(right.active) !== Boolean(left.active)) return Number(right.active) - Number(left.active);
    return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
  });
  return Number.isInteger(tabs[0]?.id) ? tabs[0].id : null;
}

function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(Object.assign(new Error(response?.error || 'Extension request failed'), {
        code: response?.code || null,
      }));
      else resolve(response.data);
    });
  });
}

async function backgroundState(tabId) {
  return runtimeMessage({ type: 'GPTLOCK_GET_STATE', ...(Number.isInteger(tabId) ? { tabId } : {}) });
}

function entitlementError(state) {
  const account = state?.account;
  if (account?.authenticated !== true || account?.entitlement?.active !== true) {
    return Object.assign(new Error('当前账号没有有效权益'), { code: 'ENTITLEMENT_REQUIRED' });
  }
  return null;
}

function quotaExceeded(state, tabId) {
  return Number.isInteger(tabId)
    && state?.account?.authenticated === true
    && state?.account?.entitlement?.active === true
    && state?.accountWindowAllowed === false;
}

async function pushFeatureState(tabId, featureState = null) {
  if (!Number.isInteger(tabId)) return;
  const state = featureState || await getTabFeatureState(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'GPTWORK_TAB_FEATURE_STATE',
      featureState: state,
      policy: effectivePolicyForTabSync(tabId),
    });
  } catch {}
}

async function pushWindowFeatureState(windowId, featureState = null) {
  if (!Number.isInteger(windowId)) return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ windowId, url: 'https://chatgpt.com/*' });
  } catch {}
  for (const tab of tabs) rememberTabWindow(tab);
  await Promise.allSettled(tabs
    .filter((tab) => Number.isInteger(tab.id))
    .map((tab) => pushFeatureState(tab.id, featureState)));
}

async function pushAllFeatureStates() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' }); } catch {}
  for (const tab of tabs) rememberTabWindow(tab);
  await Promise.allSettled(tabs
    .filter((tab) => Number.isInteger(tab.id))
    .map((tab) => pushFeatureState(tab.id)));
}

async function featureSnapshot(tabId) {
  const state = await backgroundState(tabId);
  const windowId = Number.isInteger(tabId) ? await resolveWindowIdForTab(tabId) : null;
  const featureState = Number.isInteger(tabId) ? await getTabFeatureState(tabId) : normalizeState(null);
  return {
    tabId,
    windowId,
    featureState,
    policy: Number.isInteger(tabId) ? effectivePolicyForTabSync(tabId) : basePolicy,
    settings: state?.settings ?? null,
    account: state?.account ?? null,
    accountWindowAllowed: Number.isInteger(tabId) ? state?.accountWindowAllowed !== false : true,
    windowQuotaExceeded: quotaExceeded(state, tabId),
    masterEnabled,
  };
}

async function handleFeatureMessage(message, sender) {
  const tabId = await targetTabId(message.tabId, sender);
  if (message.type === 'GPTWORK_TAB_FEATURE_GET') return featureSnapshot(tabId);

  if (message.type === 'GPTWORK_TAB_FEATURE_SET') {
    if (!Number.isInteger(tabId)) throw Object.assign(new Error('没有打开的 ChatGPT 标签页'), { code: 'NO_CHATGPT_TAB' });
    const state = await backgroundState(tabId);
    if (message.enabled === true) {
      const denied = entitlementError(state);
      if (denied) throw denied;
      if (quotaExceeded(state, tabId)) {
        throw Object.assign(new Error(WINDOW_QUOTA_MESSAGE), { code: 'WINDOW_QUOTA_EXCEEDED' });
      }
    }
    const patch = message.feature === 'work'
      ? { workModeEnabled: message.enabled === true }
      : message.feature === 'model'
        ? { modelLockEnabled: message.enabled === true }
        : null;
    if (!patch) throw Object.assign(new Error('未知功能开关'), { code: 'INVALID_FEATURE' });
    const featureState = await setTabFeatureState(tabId, patch);
    const windowId = await resolveWindowIdForTab(tabId);
    await pushWindowFeatureState(windowId, featureState);
    await scheduleAccountRefresh();
    return featureSnapshot(tabId);
  }

  if (message.type === 'GPTWORK_MASTER_STATUS') return featureSnapshot(tabId);

  if (message.type === 'GPTWORK_MASTER_SET') {
    const desired = message.enabled === true;
    const state = await backgroundState(tabId);
    if (desired) {
      const denied = entitlementError(state);
      if (denied) throw denied;
      if (quotaExceeded(state, tabId)) {
        throw Object.assign(new Error(WINDOW_QUOTA_MESSAGE), { code: 'WINDOW_QUOTA_EXCEEDED' });
      }
    }
    masterEnabled = desired;
    await chrome.storage.local.set({ [MASTER_KEY]: desired });
    await pushAllFeatureStates();
    await scheduleAccountRefresh();
    log('master_changed', { enabled: desired, tabId });
    return { ...(await featureSnapshot(tabId)), masterEnabled: desired };
  }

  throw new Error(`Unsupported tab feature message: ${message.type}`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!FEATURE_MESSAGE_TYPES.has(message?.type)) return false;
  handleFeatureMessage(message, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || null,
    }),
  );
  return true;
});

chrome.tabs.onCreated.addListener((tab) => {
  rememberTabWindow(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeTabState(tabId).catch(() => {});
});

if (chrome.tabs.onAttached?.addListener) {
  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    if (Number.isInteger(tabId) && Number.isInteger(attachInfo?.newWindowId)) {
      tabWindowIds.set(tabId, attachInfo.newWindowId);
      void pushFeatureState(tabId).catch(() => {});
    }
  });
}

if (chrome.tabs.onDetached?.addListener) {
  chrome.tabs.onDetached.addListener((tabId) => {
    tabWindowIds.delete(Number(tabId));
  });
}

// Lifecycle cleanup must always run, even while the global master switch is off.
chrome.windows.onRemoved.addListener((windowId) => {
  void removeWindowState(windowId).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[MASTER_KEY]) {
    masterEnabled = changes[MASTER_KEY].newValue === true;
    void pushAllFeatureStates().catch(() => {});
    return;
  }
  if (areaName !== 'sync') return;
  let changed = false;
  if (changes.policy) {
    basePolicy = normalizePolicy(changes.policy.newValue);
    if (!selectionWriteInFlight) {
      const nextSelection = normalizeModels(basePolicy.lockedModels);
      if (nextSelection.length) {
        modelLockSelection = nextSelection;
        if (!changes[MODEL_SELECTION_KEY]) {
          selectionWriteInFlight = true;
          void chrome.storage.sync.set({ [MODEL_SELECTION_KEY]: nextSelection })
            .catch(() => {})
            .finally(() => { selectionWriteInFlight = false; });
        }
      }
    }
    changed = true;
  }
  if (changes[MODEL_SELECTION_KEY]) {
    modelLockSelection = normalizeModels(changes[MODEL_SELECTION_KEY].newValue);
    changed = true;
  }
  if (changes[DISCOVERED_MODELS_KEY]) {
    discoveredModels = normalizeModels(changes[DISCOVERED_MODELS_KEY].newValue);
    changed = true;
  }
  if (!changed) return;
  void pushAllFeatureStates().catch(() => {});
});

void initializeTabFeatureRuntime().catch((error) => {
  log('initialize_failed', { error: error instanceof Error ? error.message : String(error) }, 'error');
});
