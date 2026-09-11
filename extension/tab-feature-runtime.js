import { normalizeConcreteModelId, normalizePolicy } from './policy.js';
import { appendRuntimeLog } from './runtime-log.js';

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

const states = new Map();
let basePolicy = normalizePolicy(null);
let modelLockSelection = [];
let discoveredModels = [];
let initialized = false;
let initializePromise = null;

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

function serializedStates() {
  return Object.fromEntries([...states.entries()].map(([tabId, value]) => [String(tabId), normalizeState(value)]));
}

async function persistStates() {
  await chrome.storage.session.set({ [TAB_FEATURE_SESSION_KEY]: serializedStates() });
}

async function migrateLegacyFlags(storedLocal) {
  if (storedLocal[TAB_FEATURE_MIGRATION_KEY] === true) return;
  const legacy = normalizeState({
    workModeEnabled: storedLocal[LEGACY_WORK_MODE_KEY] === true,
    modelLockEnabled: storedLocal[LEGACY_MODEL_LOCK_KEY] === true,
  });
  if (legacy.workModeEnabled || legacy.modelLockEnabled) {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    for (const tab of tabs) {
      if (Number.isInteger(tab.id)) states.set(tab.id, legacy);
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
    migratedTabCount: states.size,
  });
}

export async function initializeTabFeatureRuntime() {
  if (initialized) return;
  if (initializePromise) return initializePromise;
  initializePromise = (async () => {
    const [sessionStored, localStored, syncStored] = await Promise.all([
      chrome.storage.session.get(TAB_FEATURE_SESSION_KEY),
      chrome.storage.local.get([
        TAB_FEATURE_MIGRATION_KEY,
        LEGACY_WORK_MODE_KEY,
        LEGACY_MODEL_LOCK_KEY,
      ]),
      chrome.storage.sync.get(['policy', MODEL_SELECTION_KEY, DISCOVERED_MODELS_KEY]),
    ]);
    const sessionMap = sessionStored[TAB_FEATURE_SESSION_KEY];
    if (sessionMap && typeof sessionMap === 'object') {
      for (const [key, value] of Object.entries(sessionMap)) {
        const tabId = Number(key);
        if (Number.isInteger(tabId)) states.set(tabId, normalizeState(value));
      }
    }
    basePolicy = normalizePolicy(syncStored.policy);
    modelLockSelection = normalizeModels(syncStored[MODEL_SELECTION_KEY]);
    discoveredModels = normalizeModels(syncStored[DISCOVERED_MODELS_KEY]);
    await migrateLegacyFlags(localStored);
    initialized = true;
  })().finally(() => {
    initializePromise = null;
  });
  return initializePromise;
}

export function tabFeatureStateSync(tabId) {
  return normalizeState(states.get(Number(tabId)));
}

export async function getTabFeatureState(tabId) {
  await initializeTabFeatureRuntime();
  return tabFeatureStateSync(tabId);
}

export function tabFeatureEnabledSync(tabId) {
  const state = tabFeatureStateSync(tabId);
  return state.workModeEnabled || state.modelLockEnabled;
}

export function effectivePolicyForTabSync(tabId) {
  const feature = tabFeatureStateSync(tabId);
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
  const next = normalizeState({ ...tabFeatureStateSync(id), ...patch });
  states.set(id, next);
  await persistStates();
  log('tab_feature_changed', { tabId: id, ...next });
  return next;
}

async function removeTabState(tabId) {
  await initializeTabFeatureRuntime();
  if (!states.delete(Number(tabId))) return;
  await persistStates();
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
      if (isChatGptUrl(tab?.url)) return preferred;
    } catch {}
  }
  if (Number.isInteger(sender?.tab?.id) && isChatGptUrl(sender.tab.url)) return sender.tab.id;
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
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

async function refreshBackgroundRuntime() {
  try { await runtimeMessage({ type: 'GPTLOCK_ACCOUNT_REFRESH' }); } catch {}
}

async function featureSnapshot(tabId) {
  const state = await backgroundState(tabId);
  const featureState = Number.isInteger(tabId) ? await getTabFeatureState(tabId) : normalizeState(null);
  const masterStored = await chrome.storage.local.get(MASTER_KEY);
  return {
    tabId,
    featureState,
    policy: Number.isInteger(tabId) ? effectivePolicyForTabSync(tabId) : basePolicy,
    account: state?.account ?? null,
    accountWindowAllowed: Number.isInteger(tabId) ? state?.accountWindowAllowed !== false : true,
    windowQuotaExceeded: quotaExceeded(state, tabId),
    masterEnabled: typeof masterStored[MASTER_KEY] === 'boolean'
      ? masterStored[MASTER_KEY]
      : state?.settings?.enabled === true,
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
    await pushFeatureState(tabId, featureState);
    await refreshBackgroundRuntime();
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
    await chrome.storage.local.set({ [MASTER_KEY]: desired });
    await refreshBackgroundRuntime();
    log('master_changed', { enabled: desired, tabId });
    return { ...(await featureSnapshot(tabId)), masterEnabled: desired };
  }

  throw new Error(`Unsupported tab feature message: ${message.type}`);
}

// Register the per-tab authority before background.js, then shield these private message
// types from the legacy catch-all GPTLOCK receiver so exactly one listener responds.
const originalAddListener = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
originalAddListener((message, sender, sendResponse) => {
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

try {
  chrome.runtime.onMessage.addListener = (listener) => originalAddListener((message, sender, sendResponse) => {
    if (FEATURE_MESSAGE_TYPES.has(message?.type)) return false;
    return listener(message, sender, sendResponse);
  });
} catch {
  // Chrome currently exposes writable event methods. If that changes, the static tests
  // and runtime logs make the incompatibility visible rather than silently sharing state.
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeTabState(tabId).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  let changed = false;
  if (changes.policy) {
    basePolicy = normalizePolicy(changes.policy.newValue);
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
  void chrome.tabs.query({ url: 'https://chatgpt.com/*' }).then((tabs) => Promise.all(
    tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => pushFeatureState(tab.id)),
  )).catch(() => {});
});

void initializeTabFeatureRuntime().catch((error) => {
  log('initialize_failed', { error: error instanceof Error ? error.message : String(error) }, 'error');
});
