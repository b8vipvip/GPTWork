import {
  DEFAULT_POLICY,
  DEFAULT_SETTINGS,
  modelTransportId,
  normalizeConcreteModelId,
  normalizeRawProtocolModelId,
  normalizePolicy,
  normalizeReasoningLevel,
  normalizeSettings,
  toNativePolicy,
} from './policy.js';
import { ChatGptNetworkMonitor } from './network-monitor.js';
import { evaluateGuard } from './guard.js';
import { classifyNativeError } from './native-status.js';
import {
  appendDiagnosticSseCapture,
  appendRuntimeLog,
  clearRuntimeLogs,
  createDiagnosticSseCapture,
  finalizeDiagnosticSseCapture,
  getRuntimeLogs,
  markRuntimeLogsNative,
  runtimeLogNativeBatch,
  uploadRuntimeLogBatch,
  RUNTIME_LOG_UPLOAD_ALARM,
  RUNTIME_LOG_SYNC_KEY,
  sanitizeLogValue,
} from './runtime-log.js';
import { createAccountClient } from './account-client.js';
import {
  effectivePolicyForTabSync,
  requestPolicyForTabSync,
  enableWorkModeForVerification,
  isolateTabForNativeDiscovery,
  isolateTabForVerification,
  tabFeatureEnabledSync,
  tabFeatureStateSync,
} from './tab-feature-runtime.js';
import { ACCOUNT_REFRESH_ALARM } from './account-refresh-scheduler.js';
import { ensureContentRuntime } from './content-runtime-recovery.js';
import {
  createVerificationCatalog,
  summarizeVerificationOutcome,
  createModelVerificationHistoryRecord,
  shouldRetryTransientResponse,
} from './vendor/modelpro/model-verification.js';

const RUNTIME_CODE_VERSION = '0.5.184';
const NATIVE_HOST = 'com.gptlock.core';
const RECONNECT_ALARM = 'gptlock-native-reconnect';
const REQUEST_TIMEOUT_MS = 7000;
const AUTO_VERIFY_RESPONSE_TIMEOUT_MS = 120000;
const AUTO_VERIFY_POLL_MS = 200;
const AUTO_VERIFY_HANDOFF_MIN_WAIT_MS = 9000;
const AUTO_VERIFY_HANDOFF_IDLE_MS = 1200;
const DIAGNOSTIC_SSE_STORAGE_KEY = 'autoVerificationSseCapture';
const MODEL_VERIFICATION_HISTORY_KEY = 'modelVerificationHistoryV1';
const MODEL_VERIFICATION_HISTORY_ENABLED_KEY = 'gptworkModelVerificationHistoryEnabled';
const MODEL_VERIFICATION_HISTORY_LIMIT = 50;
const LOCAL_ENABLED_KEY = 'gptworkEnabledLocal';
const SHARED_KNOWN_MODELS_KEY = 'gptworkSharedKnownModelsV1';
const SHARED_MODEL_CATALOG_GENERATION_KEY = 'gptworkSharedModelCatalogGenerationV1';
const SHARED_MODEL_CATALOG_ACCOUNT_KEY = 'gptworkSharedModelCatalogAccountV1';
const SHARED_MODEL_CATALOG_SYNC_VERSION_KEY = 'gptworkSharedModelCatalogSyncVersionV1';
const LOCAL_DISCOVERED_MODELS_KEY = 'discoveredModels';
const LOCAL_DISCOVERED_EVIDENCE_KEY = 'discoveredModelEvidence';
const NETWORK_CANDIDATE_SELECTOR = '__network_candidate__';
const JANK_ISOLATION_KEY = 'gptworkJankIsolationV1';

let nativePort = null;
let requestSequence = 0;
let currentPolicy = DEFAULT_POLICY;
let currentSettings = DEFAULT_SETTINGS;
let serverFeatureSettingsReady = false;
let localEnabledOverride = null;
let coreConnection = { connected: false, error: null };
let initializeTask = null;
const pendingRequests = new Map();
const tabStates = new Map();
// Ephemeral per-tab verification transaction. This is the sole authority that can
// temporarily change request-lock behavior while a catalog model is being probed.
// It is intentionally independent of URL/context state migration.
const verificationTransactions = new Map();
// Automatic model verification is single-flight per tab. Register the task before
// autoVerify() can yield so duplicate starts join one picker/composer transaction.
const autoVerificationTasks = new Map();
const accountClient = createAccountClient();
let accountState = { authenticated: false, authorized: false, allowedWindowKeys: [], deniedWindowKeys: [] };
let sharedModelCatalogUnavailableUntil = 0;
let sharedKnownModelIds = new Set();
let sharedModelProtocolMap = new Map();
let sharedPickerBChatModelIds = new Set();
let lastServerModelCatalogGeneration = null;

function rememberProvenPickerBChatModels(items) {
  sharedPickerBChatModelIds = new Set((Array.isArray(items) ? items : [])
    .filter((item) => item?.pickerMode === 'B' && normalizeRawProtocolModelId(item?.chatTransportModel))
    .map((item) => normalizeConcreteModelId(item?.model))
    .filter(Boolean));
}
let diagnosticRuntimeSuspended = false;

function masterRuntimeEnabled() {
  return localEnabledOverride === true && currentSettings.enabled === true && !diagnosticRuntimeSuspended;
}

function serverWorkFeatureEnabled() {
  return serverFeatureSettingsReady === true && currentSettings.workModeFeatureEnabled === true;
}

async function masterStorageEnabled() {
  try {
    const stored = await chrome.storage.local.get(LOCAL_ENABLED_KEY);
    return stored?.[LOCAL_ENABLED_KEY] === true;
  } catch {
    return false;
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function collectJankPhaseSnapshot(phase, { reset = true } = {}) {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const snapshots = [];
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GPTWORK_DIAGNOSTIC_PERF_SNAPSHOT',
        reset,
      });
      if (response?.ok) {
        snapshots.push({
          tabId: tab.id,
          windowId: tab.windowId,
          active: tab.active === true,
          details: response.details || null,
        });
      }
    } catch {}
  }
  return {
    captureId: phase.captureId || null,
    label: phase.label || phase.mode || 'unknown',
    mode: phase.mode || 'normal',
    startedAt: phase.changedAt || null,
    endedAt: new Date().toISOString(),
    tabs: snapshots,
  };
}

async function resetJankPhaseTelemetry() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'GPTWORK_DIAGNOSTIC_PERF_SNAPSHOT',
        reset: true,
      });
    } catch {}
  }
}

async function applyJankIsolationMode(mode = 'normal', {
  source = 'runtime',
  label = null,
  captureId = null,
} = {}) {
  const normalized = ['normal', 'cdp_off', 'content_off', 'high_level_off', 'runtime_off'].includes(mode) ? mode : 'normal';
  const previous = (await chrome.storage.local.get(JANK_ISOLATION_KEY))[JANK_ISOLATION_KEY] || { mode: 'normal' };
  const wasRuntimeOff = diagnosticRuntimeSuspended;
  const sameCapture = Boolean(captureId && previous.captureId === captureId);
  let completedPhase = null;
  if (sameCapture && previous.label && previous.label !== 'restore_normal') {
    completedPhase = await collectJankPhaseSnapshot(previous, { reset: true });
    logRuntime('info', 'diagnostics', 'jank_phase_snapshot', completedPhase);
  }

  const state = {
    mode: normalized,
    label: String(label || normalized).slice(0, 80),
    captureId: captureId ? String(captureId).slice(0, 120) : null,
    previousMode: previous.mode || 'normal',
    changedAt: new Date().toISOString(),
    source,
  };
  await chrome.storage.local.set({ [JANK_ISOLATION_KEY]: state });

  const runtimeOff = normalized === 'runtime_off';
  diagnosticRuntimeSuspended = runtimeOff;
  const cdpOff = normalized === 'cdp_off' || normalized === 'high_level_off' || runtimeOff;
  const contentOff = normalized === 'content_off' || normalized === 'high_level_off' || runtimeOff;
  const captureActive = Boolean(state.captureId && state.label !== 'restore_normal');
  if (runtimeOff && !wasRuntimeOff) await stopBackgroundRuntime('diagnostic_runtime_off');
  const cdp = await networkMonitor.setDiagnosticSuspended(cdpOff);
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  let contentTabs = 0;
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GPTWORK_DIAGNOSTIC_CONTENT_SUSPEND',
        suspended: contentOff,
        captureActive,
      });
      if (response?.ok) contentTabs += 1;
    } catch {}
  }
  if (!runtimeOff && wasRuntimeOff) {
    await initializeAfterCurrentTask();
  } else if (!cdpOff) {
    await configureOpenTabs();
  }
  if (!sameCapture && state.captureId) await resetJankPhaseTelemetry();

  logRuntime('info', 'diagnostics', 'jank_isolation_changed', {
    ...state,
    runtimeSuspended: runtimeOff,
    cdpSuspended: cdp.suspended,
    detachedTabs: cdp.detachedTabs,
    contentSuspended: contentOff,
    contentTabs,
    captureActive,
    completedPhaseLabel: completedPhase?.label || null,
  });
  return {
    ...state,
    runtimeSuspended: runtimeOff,
    cdp,
    contentSuspended: contentOff,
    contentTabs,
    captureActive,
    completedPhase,
  };
}

let runtimeLogFlushTimer = null;
function scheduleRuntimeLogDelivery() {
  if (runtimeLogFlushTimer !== null) return;
  runtimeLogFlushTimer = setTimeout(() => {
    runtimeLogFlushTimer = null;
    // Browser storage is the canonical log. Native-file and server copies are delivery
    // sinks only; both consume the same immutable entry ids and acknowledge independently.
    void syncRuntimeLogsToNative().catch(() => {});
  }, 750);
}

function logRuntime(level, component, event, details = {}) {
  void appendRuntimeLog(level, component, event, details)
    .then(() => scheduleRuntimeLogDelivery())
    .catch(() => {});
}

async function startAutoVerificationStreamCapture(tabId, startedAt) {
  const capture = createDiagnosticSseCapture({ tabId, startedAt });
  await chrome.storage.local.set({ [DIAGNOSTIC_SSE_STORAGE_KEY]: capture });
  return capture;
}

async function captureAutoVerificationStream(tabId, state, evidence) {
  const rawData = typeof evidence?.rawStreamData === 'string'
    ? evidence.rawStreamData
    : evidence?.rawResponseBody;
  const mimeType = String(evidence?.diagnostics?.mimeType || '');
  const bodyFormat = String(evidence?.diagnostics?.bodyFormat || '');
  const transport = evidence?.streamContext?.transport
    || evidence?.diagnostics?.transport
    || (/event-stream/i.test(mimeType) || bodyFormat.includes('sse') ? 'sse' : 'unknown');
  const isDownstream = Boolean(evidence?.streamContext?.isDownstream);
  if (!state.autoVerification?.running || typeof rawData !== 'string' || !rawData) return null;
  if (transport === 'unknown' && !isDownstream) return null;
  if (!isDownstream && state.lastRequest?.requestId && state.lastRequest.requestId !== evidence.requestId) return null;

  const stored = await chrome.storage.local.get(DIAGNOSTIC_SSE_STORAGE_KEY);
  let capture = stored[DIAGNOSTIC_SSE_STORAGE_KEY];
  if (!capture || capture.tabId !== tabId || capture.startedAt !== state.autoVerification.startedAt) {
    capture = createDiagnosticSseCapture({ tabId, startedAt: state.autoVerification.startedAt });
  }
  const beforeIncludedBytes = Number(capture.includedBytes || 0);
  const next = appendDiagnosticSseCapture(capture, {
    attempt: state.autoVerification.attempt ?? null,
    requestId: evidence.requestId ?? null,
    capturedAt: evidence.capturedAt ?? new Date().toISOString(),
    endpoint: evidence.diagnostics?.endpoint ?? null,
    httpStatus: evidence.diagnostics?.httpStatus ?? evidence.status ?? null,
    mimeType,
    bodyFormat,
    transport,
    direction: evidence?.streamContext?.direction ?? evidence?.diagnostics?.direction ?? 'received',
    stage: evidence?.streamContext?.stage ?? evidence?.diagnostics?.stage ?? null,
    streamContext: evidence?.streamContext ?? null,
    requestModel: state.lastRequest?.model ?? null,
    rewriteReason: state.lastRewrite?.reason ?? null,
    rawData,
  });
  await chrome.storage.local.set({ [DIAGNOSTIC_SSE_STORAGE_KEY]: next });
  logRuntime(next.overflowed ? 'warn' : 'info', 'diagnostics', 'auto_verify_stream_captured', {
    tabId,
    attempt: state.autoVerification.attempt ?? null,
    requestId: evidence.requestId ?? null,
    transport,
    direction: evidence?.streamContext?.direction ?? evidence?.diagnostics?.direction ?? 'received',
    stage: evidence?.streamContext?.stage ?? evidence?.diagnostics?.stage ?? null,
    addedBytes: Math.max(0, Number(next.includedBytes || 0) - beforeIncludedBytes),
    includedBytes: next.includedBytes,
    totalBytes: next.totalBytes,
    maxBytes: next.maxBytes,
    overflowed: next.overflowed,
    omittedResponses: next.omittedResponses,
  });
  return next;
}

async function finalizeAutoVerificationStreamCapture(tabId, completedAt) {
  const stored = await chrome.storage.local.get(DIAGNOSTIC_SSE_STORAGE_KEY);
  let capture = stored[DIAGNOSTIC_SSE_STORAGE_KEY];
  const state = tabStates.get(tabId);
  if (!capture || capture.tabId !== tabId) {
    capture = createDiagnosticSseCapture({ tabId, startedAt: state?.autoVerification?.startedAt ?? null });
  }
  const finalized = finalizeDiagnosticSseCapture(capture, completedAt);
  await chrome.storage.local.set({ [DIAGNOSTIC_SSE_STORAGE_KEY]: finalized });
  return finalized;
}

async function clearAutoVerificationStreamCapture() {
  await chrome.storage.local.remove(DIAGNOSTIC_SSE_STORAGE_KEY);
}

function isChatGptUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}

function contextKey(value) {
  try {
    const url = new URL(value);
    const conversation = url.pathname.match(/(?:^|\/)c\/([a-zA-Z0-9_-]+)/);
    return conversation ? `conversation:${conversation[1]}` : `page:${url.pathname}`;
  } catch {
    return 'unknown';
  }
}

function createTabState(tabId, url = '') {
  return {
    tabId,
    url,
    windowId: null,
    contextKey: contextKey(url),
    core: coreConnection,
    monitor: { attached: false, error: null },
    phase: 'initial',
    probeUsed: false,
    probeArmed: false,
    pageObservation: null,
    lastRewrite: null,
    lastRequest: null,
    lastVerification: null,
    lastResponseEvidence: null,
    lastEvidenceDiagnostics: null,
    streamTracking: null,
    evidenceIssue: null,
    lastError: null,
    autoVerification: null,
    updatedAt: new Date().toISOString(),
  };
}

function ensureTabState(tabId, url = '') {
  let state = tabStates.get(tabId);
  if (!state) {
    state = createTabState(tabId, url);
    tabStates.set(tabId, state);
  } else if (url && state.contextKey !== contextKey(url)) {
    const nextContextKey = contextKey(url);
    const preserveVerificationState = Boolean(
      state.autoVerification?.running
        || verificationTransactionForTab(tabId)
        || (state.autoVerification && !state.contextKey.startsWith('conversation:') && nextContextKey.startsWith('conversation:')),
    );
    if (preserveVerificationState) {
      const previousContextKey = state.contextKey;
      state.url = url;
      state.contextKey = nextContextKey;
      logRuntime('info', 'discovery', 'auto_verify_context_migrated', {
        tabId,
        previousContextKey,
        nextContextKey,
        running: Boolean(state.autoVerification?.running),
      });
    } else {
      const monitor = state.monitor;
      state = createTabState(tabId, url);
      state.monitor = monitor;
      tabStates.set(tabId, state);
    }
  } else if (url) {
    state.url = url;
  }
  return state;
}

function accountAllowsState(state) {
  if (!accountState?.authenticated || !accountState?.entitlement?.active) return false;
  const windowKey = Number.isInteger(state?.windowId) ? `chrome:${state.windowId}` : null;
  if (!windowKey) return true;
  const allowed = Array.isArray(accountState.allowedWindowKeys) ? accountState.allowedWindowKeys : [];
  const denied = Array.isArray(accountState.deniedWindowKeys) ? accountState.deniedWindowKeys : [];
  if (!allowed.length && !denied.length) return true;
  return allowed.includes(windowKey) && !denied.includes(windowKey);
}

function effectiveSettingsForState(state) {
  const workModeFeatureEnabled = serverWorkFeatureEnabled();
  const verification = verificationTransactionForTab(state?.tabId);
  if (verification) {
    // Model verification is an isolated measurement transaction. User Work/model-lock
    // switches must not block the fixed probe or alter the model ChatGPT actually sends.
    // Work availability remains server-authoritative even during verification.
    return {
      ...currentSettings,
      workModeFeatureEnabled,
      enabled: true,
      networkVerificationEnabled: true,
      autoAlignSelection: false,
    };
  }
  return {
    ...currentSettings,
    workModeFeatureEnabled,
    enabled: Boolean(
      currentSettings.enabled
        && accountAllowsState(state)
        && tabFeatureEnabledSync(state?.tabId),
    ),
  };
}

function verificationTransactionForTab(tabId) {
  return verificationTransactions.get(Number(tabId)) || null;
}

function workBootstrapModelForTab(tabId) {
  const policy = effectivePolicyForTabSync(tabId);
  return normalizeConcreteModelId(policy.workDefaultModel)
    ?? normalizeConcreteModelId(DEFAULT_POLICY.workDefaultModel);
}

function beginWorkBootstrapTransaction(tabId, source) {
  const normalizedTabId = Number(tabId);
  const previous = verificationTransactionForTab(normalizedTabId);
  const model = workBootstrapModelForTab(normalizedTabId);
  if (!model) throw new Error('Work bootstrap model is unavailable');
  verificationTransactions.set(normalizedTabId, {
    model,
    selectorKey: '__work_bootstrap__',
    label: 'Work bootstrap',
    startedAt: Date.now(),
    kind: 'work-bootstrap',
    source: String(source || 'work-bootstrap'),
  });
  return { previous, model };
}

function endWorkBootstrapTransaction(tabId, previous) {
  const normalizedTabId = Number(tabId);
  if (previous) verificationTransactions.set(normalizedTabId, previous);
  else verificationTransactions.delete(normalizedTabId);
}

function runtimePolicyForTabSync(tabId) {
  const state = tabStates.get(Number(tabId));
  const pageModel = normalizeConcreteModelId(state?.pageObservation?.model);
  const policy = requestPolicyForTabSync(tabId, pageModel);
  const transaction = verificationTransactionForTab(tabId);
  if (transaction?.model) {
    return normalizePolicy({ ...policy, lockedModels: [transaction.model] });
  }

  // Picker B is absent from ordinary Chat's picker. If Model Lock targets B, promote
  // it only after discovery has proved the exact raw transport works in Chat.
  const feature = tabFeatureStateSync(tabId);
  if (feature.modelLockEnabled === true && feature.workModeEnabled !== true && policy.lockedModels.length === 0) {
    const effective = effectivePolicyForTabSync(tabId);
    const crossModePickerB = effective.lockedModels.find((model) =>
      sharedPickerBChatModelIds.has(model) && sharedModelProtocolMap.has(model)
    ) || null;
    if (crossModePickerB) {
      return normalizePolicy({ ...policy, lockedModels: [crossModePickerB] });
    }
  }
  return policy;
}

function guardFor(state) {
  return evaluateGuard({
    state,
    policy: runtimePolicyForTabSync(state?.tabId),
    settings: effectiveSettingsForState(state),
    inScope: isChatGptUrl(state.url),
  });
}

function publicTabState(state) {
  if (!state) return null;
  return {
    contextKey: state.contextKey,
    core: state.core,
    monitor: state.monitor,
    phase: state.phase,
    probeUsed: state.probeUsed,
    probeArmed: state.probeArmed,
    pageObservation: state.pageObservation,
    lastRewrite: state.lastRewrite,
    lastRequest: state.lastRequest,
    lastVerification: state.lastVerification,
    lastResponseEvidence: state.lastResponseEvidence,
    lastEvidenceDiagnostics: state.lastEvidenceDiagnostics,
    streamTracking: state.streamTracking,
    evidenceIssue: state.evidenceIssue,
    lastError: state.lastError,
    autoVerification: state.autoVerification,
    knownModels: [...sharedKnownModelIds],
    updatedAt: state.updatedAt,
    guard: guardFor(state),
  };
}

async function updateTabBadge(state) {
  const guard = guardFor(state);
  let text = 'L';
  let color = '#2563eb';
  if (guard.status === 'verified') {
    text = 'OK';
    color = '#15803d';
  } else if (guard.status === 'mismatch' && !guard.canSend) {
    text = '!';
    color = '#b91c1c';
  } else if (guard.status === 'waiting') {
    text = '…';
    color = '#b45309';
  } else if (['monitor_offline', 'core_offline', 'error', 'unverified'].includes(guard.status)) {
    text = '?';
    color = '#b45309';
  } else if (guard.status === 'disabled') {
    text = 'OFF';
    color = '#64748b';
  }
  try {
    await chrome.action.setBadgeText({ tabId: state.tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId: state.tabId, color });
  } catch {
    // The tab may have closed between the event and the badge update.
  }
}

async function broadcastTabState(tabId) {
  const state = tabStates.get(tabId);
  if (!state) return;
  if (!masterRuntimeEnabled()) {
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch {}
    return;
  }
  state.updatedAt = new Date().toISOString();
  await updateTabBadge(state);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'GPTLOCK_GUARD_STATE',
      state: publicTabState(state),
      policy: runtimePolicyForTabSync(tabId),
      settings: effectiveSettingsForState(state),
    });
  } catch {
    // A content script may not exist yet while a tab is loading.
  }
}

async function ensureConfiguration() {
  const [stored, localStored] = await Promise.all([
    chrome.storage.sync.get(['policy', 'settings', SHARED_KNOWN_MODELS_KEY]),
    chrome.storage.local.get(LOCAL_ENABLED_KEY),
  ]);
  sharedKnownModelIds = new Set(
    (Array.isArray(stored[SHARED_KNOWN_MODELS_KEY]) ? stored[SHARED_KNOWN_MODELS_KEY] : [])
      .map((item) => normalizeConcreteModelId(item?.model))
      .filter(Boolean),
  );
  currentPolicy = normalizePolicy(stored.policy ?? DEFAULT_POLICY);
  const syncedSettings = normalizeSettings(stored.settings ?? DEFAULT_SETTINGS);
  localEnabledOverride = typeof localStored?.[LOCAL_ENABLED_KEY] === 'boolean'
    ? localStored[LOCAL_ENABLED_KEY]
    : syncedSettings.enabled;
  currentSettings = normalizeSettings({ ...syncedSettings, enabled: localEnabledOverride });
  if (typeof localStored?.[LOCAL_ENABLED_KEY] !== 'boolean') {
    await chrome.storage.local.set({ [LOCAL_ENABLED_KEY]: localEnabledOverride });
  }
  const patch = {};
  if (!stored.policy || JSON.stringify(stored.policy) !== JSON.stringify(currentPolicy)) patch.policy = currentPolicy;
  if (!stored.settings || JSON.stringify(stored.settings) !== JSON.stringify(syncedSettings)) patch.settings = syncedSettings;
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
  return { policy: currentPolicy, settings: currentSettings };
}

async function writeNativeStatus(patch) {
  const { nativeStatus = {} } = await chrome.storage.local.get('nativeStatus');
  const next = {
    connected: false,
    lastError: null,
    lastSeenAt: null,
    lastVerification: null,
    ...nativeStatus,
    ...patch,
  };
  if (Object.hasOwn(patch, 'lastError')) next.errorCode = classifyNativeError(patch.lastError);
  await chrome.storage.local.set({ nativeStatus: next });
  if (
    nativeStatus.connected !== next.connected
    || nativeStatus.lastError !== next.lastError
    || nativeStatus.version !== next.version
  ) {
    logRuntime(next.connected ? 'info' : 'warn', 'native', 'status_changed', {
      connected: next.connected,
      version: next.version ?? null,
      errorCode: next.errorCode ?? null,
      lastError: next.lastError ?? null,
    });
  }
  coreConnection = { connected: Boolean(next.connected), error: next.lastError ?? null };
  for (const state of tabStates.values()) {
    state.core = coreConnection;
    void broadcastTabState(state.tabId);
  }
  return next;
}

async function scheduleReconnect() {
  if (!await masterStorageEnabled()) return false;
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
  return true;
}

function rejectPending(error) {
  for (const { reject, timer, type } of pendingRequests.values()) {
    clearTimeout(timer);
    reject(error);
    logRuntime('warn', 'native', 'request_rejected', { type, error: errorText(error) });
  }
  pendingRequests.clear();
}

async function markNativeStopped() {
  try {
    const { nativeStatus = {} } = await chrome.storage.local.get('nativeStatus');
    await chrome.storage.local.set({
      nativeStatus: {
        ...nativeStatus,
        connected: false,
        lastError: null,
        errorCode: null,
      },
    });
  } catch {}
  coreConnection = { connected: false, error: null };
  for (const state of tabStates.values()) state.core = coreConnection;
}

async function stopBackgroundRuntime(reason = 'master_disabled') {
  const port = nativePort;
  nativePort = null;
  rejectPending(new Error('GPTWork master disabled'));
  try { port?.disconnect(); } catch {}
  await Promise.allSettled([
    chrome.alarms.clear(RECONNECT_ALARM),
    chrome.alarms.clear(ACCOUNT_REFRESH_ALARM),
  ]);
  await markNativeStopped();
  for (const tabId of [...tabStates.keys()]) {
    try { await networkMonitor.detach(tabId); } catch {}
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch {}
  }
  logRuntime('info', 'extension', 'background_runtime_stopped', { reason, tabs: tabStates.size });
}

function connectNative() {
  if (!masterRuntimeEnabled()) {
    throw Object.assign(new Error('GPTWork master disabled'), { code: 'MASTER_DISABLED' });
  }
  if (nativePort) return nativePort;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    port.onMessage.addListener((message) => {
      const pending = pendingRequests.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(String(message.id));
      if (message.ok) {
        pending.resolve(message.data);
      } else {
        const error = new Error(message.error?.messageZhCn || message.error?.messageEn || 'Native request failed');
        logRuntime('error', 'native', 'request_failed', {
          type: pending.type,
          code: message.error?.code ?? null,
          error: error.message,
        });
        pending.reject(error);
      }
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      const detail = chrome.runtime.lastError?.message || 'Native host disconnected';
      nativePort = null;
      rejectPending(new Error(detail));
      if (masterRuntimeEnabled()) {
        void writeNativeStatus({ connected: false, lastError: detail });
        void scheduleReconnect();
        logRuntime('warn', 'native', 'disconnected', { error: detail });
      } else {
        void markNativeStopped();
      }
    });
    void writeNativeStatus({ connected: true, lastError: null, lastSeenAt: new Date().toISOString() });
    return port;
  } catch (error) {
    const detail = errorText(error);
    if (masterRuntimeEnabled()) {
      void writeNativeStatus({ connected: false, lastError: detail });
      void scheduleReconnect();
      logRuntime('error', 'native', 'connect_failed', { error: detail });
    }
    throw error;
  }
}

function sendNative(type, payload = {}) {
  if (!masterRuntimeEnabled()) {
    return Promise.reject(Object.assign(new Error('GPTWork master disabled'), { code: 'MASTER_DISABLED' }));
  }
  const port = connectNative();
  const id = `${Date.now()}-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      const error = new Error(`Native request timed out: ${type}`);
      logRuntime('error', 'native', 'request_timeout', { type, timeoutMs: REQUEST_TIMEOUT_MS });
      reject(error);
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timer, type });
    try {
      port.postMessage({ id, type, ...payload });
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      logRuntime('error', 'native', 'post_message_failed', { type, error: errorText(error) });
      reject(error);
    }
  });
}

let nativeLogSyncQueue = Promise.resolve();
async function syncRuntimeLogsToNative() {
  nativeLogSyncQueue = nativeLogSyncQueue.catch(() => {}).then(async () => {
    if (!masterRuntimeEnabled()) return { written: 0, skipped: 'master_disabled' };
    let total = 0;
  // Drain several small batches without blocking ordinary verification messages for long.
  for (let pass = 0; pass < 40; pass += 1) {
    const records = await runtimeLogNativeBatch(50);
    if (!records.length) break;
    const result = await sendNative('append_runtime_logs', { records });
    const written = Number(result?.written || 0);
    if (written <= 0) break;
    await markRuntimeLogsNative(records.slice(0, written).map((entry) => entry.id));
    total += written;
    if (records.length < 50) break;
  }
    return { written: total };
  });
  return nativeLogSyncQueue;
}

async function syncPolicy() {
  const result = await sendNative('set_policy', { policy: toNativePolicy(currentPolicy) });
  await writeNativeStatus({
    connected: true,
    lastError: null,
    lastSeenAt: new Date().toISOString(),
    policyRevision: result.revision,
  });
  return result;
}

async function verifyObservation(observation, policy = currentPolicy) {
  const result = await sendNative('verify', {
    policy: toNativePolicy(policy),
    observation: {
      model: observation.model ?? null,
      reasoning: observation.reasoning ?? null,
      evidenceSource: observation.evidenceSource,
      capturedAt: observation.capturedAt ?? new Date().toISOString(),
      requestId: observation.requestId || `extension-${Date.now()}-${++requestSequence}`,
    },
  });
  await writeNativeStatus({
    connected: true,
    lastError: null,
    lastSeenAt: new Date().toISOString(),
    lastVerification: result,
    policyRevision: result.policyRevision,
  });
  return result;
}

function responseEvidenceRequestId(evidence) {
  return evidence?.streamContext?.initialRequestId
    || evidence?.requestId
    || null;
}

function mergeResponseEvidence(state, evidence) {
  const requestId = responseEvidenceRequestId(evidence)
    || state.lastRequest?.requestId
    || null;
  // A response observation is authoritative only for the evidence carried by that
  // observation. Never inherit a previously observed model into a later packet
  // that contains zero model candidates: that manufactured stale Sol mismatches
  // in v0.5.133 after the actual request had moved to GPT-6 Sol.
  const currentHasModelAuthority = Boolean(
    evidence?.model
      || evidence?.conflicts?.model
      || Number(evidence?.diagnostics?.modelCandidateCount || 0) > 0
  );
  const previous = state.lastResponseEvidence?.requestId === requestId
    ? state.lastResponseEvidence
    : null;
  const previousModel = currentHasModelAuthority ? previous?.model : null;
  const previousModelConflict = currentHasModelAuthority ? previous?.conflicts?.model : false;
  const modelConflict = Boolean(
    evidence?.conflicts?.model
      || previousModelConflict
      || (previousModel && evidence?.model && previousModel !== evidence.model),
  );
  const reasoningConflict = Boolean(
    evidence?.conflicts?.reasoning
      || previous?.conflicts?.reasoning
      || (previous?.reasoning && evidence?.reasoning && previous.reasoning !== evidence.reasoning),
  );
  const merged = {
    requestId,
    capturedAt: evidence?.capturedAt ?? previous?.capturedAt ?? new Date().toISOString(),
    model: modelConflict ? null : evidence?.model || previousModel || null,
    rawModel: evidence?.rawModel || previous?.rawModel || null,
    defaultModel: evidence?.defaultModel || previous?.defaultModel || null,
    rawDefaultModel: evidence?.rawDefaultModel || previous?.rawDefaultModel || null,
    defaultModelField: evidence?.defaultModelField || previous?.defaultModelField || null,
    reasoning: reasoningConflict ? null : evidence?.reasoning || previous?.reasoning || null,
    conflicts: { model: modelConflict, reasoning: reasoningConflict },
    fields: {
      model: evidence?.fields?.model || (currentHasModelAuthority ? previous?.fields?.model : null) || null,
      reasoning: evidence?.fields?.reasoning || previous?.fields?.reasoning || null,
    },
    bodyError: evidence?.bodyError || previous?.bodyError || null,
    evidenceSource: 'network_response_metadata',
    diagnostics: evidence?.diagnostics ?? previous?.diagnostics ?? null,
    streamContext: evidence?.streamContext ?? previous?.streamContext ?? null,
  };
  state.lastResponseEvidence = merged;
  return merged;
}

function verificationResponseObservation(tabId, responseEvidence) {
  const transaction = verificationTransactionForTab(tabId);
  const target = normalizeConcreteModelId(transaction?.model);
  const observed = normalizeConcreteModelId(responseEvidence?.model);
  const field = String(responseEvidence?.fields?.model || '');
  // Response confirmation is intentionally independent from request rewriting and
  // Work profile/default metadata. Only a directly observed network response field
  // with served/resolved/used semantics (or an allowed response header normalized by
  // network-evidence.js) can confirm the backend model.
  return {
    model: responseEvidence?.conflicts?.model ? null : observed,
    rawModel: responseEvidence?.conflicts?.model ? null : normalizeRawProtocolModelId(responseEvidence?.rawModel),
    backendResolvedModel: observed || null,
    downgraded: false,
    reason: target && observed && observed !== target ? 'served_model_mismatch' : null,
    field,
  };
}

function diagnoseEvidenceIssue(evidence, result) {
  if (evidence.bodyError) return 'response_body_read_failed';
  if (evidence.conflicts?.model || evidence.conflicts?.reasoning) return 'response_metadata_conflict';
  const format = evidence.diagnostics?.bodyFormat;
  if (format === 'empty') return 'response_body_empty';
  if (format === 'too_large') return 'response_body_too_large';
  if (format === 'unparsed') return 'response_body_unparseable';
  if (result.reason === 'model_missing') return 'response_model_not_exposed';
  if (result.reason === 'reasoning_missing') return 'response_reasoning_not_exposed';
  return result.verdict === 'verified' ? null : 'response_metadata_incomplete';
}

async function applyNetworkEvidence(tabId, evidence) {
  const state = ensureTabState(tabId);
  const evidenceRequestId = responseEvidenceRequestId(evidence);
  const currentRequestId = state.lastRequest?.requestId || null;
  if (currentRequestId && evidenceRequestId && evidenceRequestId !== currentRequestId) {
    logRuntime('info', 'network', 'response_evidence_ignored_stale_request', {
      tabId,
      currentRequestId,
      evidenceRequestId,
      transport: evidence?.streamContext?.transport || evidence?.diagnostics?.transport || null,
    });
    evidence.rawResponseBody = null;
    return;
  }
  const handoff = evidence?.diagnostics?.streamHandoff;
  if (handoff) {
    state.streamTracking = {
      detectedAt: Date.now(),
      lastActivityAt: Date.now(),
      downstreamEvidenceCount: 0,
      transports: [],
      handoff,
    };
    logRuntime('info', 'network', 'stream_handoff_detected', { tabId, handoff });
  }
  if (evidence?.streamContext?.isDownstream) {
    const tracking = state.streamTracking || {
      detectedAt: Date.now(),
      lastActivityAt: Date.now(),
      downstreamEvidenceCount: 0,
      transports: [],
      handoff: null,
    };
    tracking.lastActivityAt = Date.now();
    tracking.downstreamEvidenceCount += 1;
    const transport = evidence.streamContext.transport || evidence?.diagnostics?.transport || 'unknown';
    if (!tracking.transports.includes(transport)) tracking.transports.push(transport);
    state.streamTracking = tracking;
  }
  try {
    await captureAutoVerificationStream(tabId, state, evidence);
  } catch (error) {
    logRuntime('warn', 'diagnostics', 'auto_verify_stream_capture_failed', { tabId, error: errorText(error) });
  } finally {
    evidence.rawResponseBody = null;
  }
  const responseEvidence = mergeResponseEvidence(state, evidence);
  state.lastEvidenceDiagnostics = responseEvidence.diagnostics ?? null;
  if (!masterRuntimeEnabled()) return;

  // Downstream generation can emit many packets carrying the same served-model
  // metadata. Once this exact request is verified, keep that terminal proof unless a
  // later packet introduces contradictory model/reasoning evidence.
  const verificationRequestId = responseEvidence.requestId
    ? `cdp-${tabId}-${responseEvidence.requestId}`
    : null;
  const directModel = normalizeConcreteModelId(evidence?.model);
  const directReasoning = normalizeReasoningLevel(evidence?.reasoning);
  const priorVerified = state.lastVerification?.verdict === 'verified'
    && verificationRequestId
    && state.lastVerification?.requestId === verificationRequestId;
  const addsContradiction = Boolean(
    evidence?.conflicts?.model
      || evidence?.conflicts?.reasoning
      || (directModel && normalizeConcreteModelId(state.lastVerification?.model) !== directModel)
      || (directReasoning && normalizeReasoningLevel(state.lastVerification?.reasoning) !== directReasoning)
  );
  if (priorVerified && !addsContradiction) return;

  try {
    const modelObservation = verificationResponseObservation(tabId, responseEvidence);
    if (modelObservation.downgraded) {
      responseEvidence.diagnostics = {
        ...(responseEvidence.diagnostics || {}),
        backendResolvedModel: modelObservation.backendResolvedModel,
        selectedModelEvidenceDowngraded: true,
        selectedModelEvidenceReason: modelObservation.reason,
      };
      state.lastEvidenceDiagnostics = responseEvidence.diagnostics;
      logRuntime('info', 'discovery', 'backend_model_resolution_observed', {
        tabId,
        verificationModel: verificationTransactionForTab(tabId)?.model ?? null,
        backendResolvedModel: modelObservation.backendResolvedModel,
        field: responseEvidence.fields?.model ?? null,
      });
    }
    const result = await verifyObservation({
      model: modelObservation.model,
      reasoning: responseEvidence.conflicts?.reasoning ? null : responseEvidence.reasoning,
      evidenceSource: 'network_response_metadata',
      capturedAt: responseEvidence.capturedAt,
      requestId: `cdp-${tabId}-${responseEvidence.requestId || evidence.requestId}`,
    }, runtimePolicyForTabSync(tabId));
    state.lastVerification = result;
    state.evidenceIssue = diagnoseEvidenceIssue(responseEvidence, result);
    state.lastError = responseEvidence.bodyError || (responseEvidence.conflicts?.model || responseEvidence.conflicts?.reasoning
      ? 'conflicting_response_metadata'
      : null);
    state.phase = result.verdict;
    logRuntime(result.verdict === 'verified' ? 'info' : 'warn', 'discovery', 'response_evaluated', {
      tabId,
      requestId: evidence?.streamContext?.initialRequestId ?? evidence.requestId ?? null,
      verdict: result.verdict,
      decision: result.decision,
      reason: result.reason,
      reasons: result.reasons,
      model: result.model,
      reasoning: result.reasoning,
      evidenceSource: result.evidenceSource,
      evidenceIssue: state.evidenceIssue,
      diagnostics: responseEvidence.diagnostics ?? null,
    });
  } catch (error) {
    state.phase = 'error';
    state.evidenceIssue = 'verification_request_failed';
    state.lastError = errorText(error);
    logRuntime('error', 'discovery', 'response_evaluation_failed', {
      tabId,
      requestId: evidence?.streamContext?.initialRequestId ?? evidence.requestId ?? null,
      error: state.lastError,
      diagnostics: evidence.diagnostics ?? null,
    });
  }
  await broadcastTabState(tabId);
}

const networkMonitor = new ChatGptNetworkMonitor({
  getLockConfiguration(tabId) {
    const policy = runtimePolicyForTabSync(tabId);
    const feature = tabFeatureStateSync(tabId);
    const crossModePickerB = feature.modelLockEnabled === true && feature.workModeEnabled !== true
      ? policy.lockedModels.find((model) =>
        sharedPickerBChatModelIds.has(model) && sharedModelProtocolMap.has(model)
      ) || null
      : null;
    const crossModeTransport = crossModePickerB
      ? normalizeRawProtocolModelId(sharedModelProtocolMap.get(crossModePickerB))
      : null;
    return {
      lockedModels: policy.lockedModels,
      allowedReasoningLevels: policy.allowedReasoningLevels,
      preferredReasoning: currentSettings.preferredReasoning,
      preserveModel: false,
      preserveReasoning: false,
      bypassRewrite: false,
      // Normal Chat may lock Picker B only through a transport proven by the
      // official-Work native probe plus the Chat compatibility probe.
      forceModel: crossModePickerB,
      forceTransportModel: crossModeTransport,
      responseVerificationEnabled: currentSettings.networkVerificationEnabled,
      knownModels: [...sharedKnownModelIds],
      modelTransportMap: Object.fromEntries(sharedModelProtocolMap),
    };
  },

  getVerificationTransaction(tabId) {
    const transaction = verificationTransactionForTab(tabId);
    if (!transaction?.model) return null;
    return {
      model: transaction.model,
      mode: transaction.mode || 'force-model',
      transportModel: normalizeRawProtocolModelId(transaction.transportModel),
      startedAt: transaction.startedAt ?? null,
    };
  },
  onStatus(tabId, monitor) {
    const state = ensureTabState(tabId);
    state.monitor = monitor;
    const detachedWhileWaiting = !monitor.attached && state.phase === 'waiting';
    if (detachedWhileWaiting) {
      state.phase = 'error';
      state.lastError = monitor.error || 'request_lock_monitor_detached';
    }
    // Picker/navigation transitions can detach CDP cleanly. Keep those lifecycle
    // transitions visible in diagnostics without promoting them to warnings unless
    // verification was actively waiting on the monitor or the detach carried an error.
    const monitorLevel = monitor.attached || (!monitor.error && !detachedWhileWaiting) ? 'info' : 'warn';
    logRuntime(monitorLevel, 'network', 'monitor_status', {
      tabId,
      attached: monitor.attached,
      error: monitor.error,
      detachedWhileWaiting,
    });
    void broadcastTabState(tabId);
  },
  onRewrite(tabId, rewrite) {
    const state = ensureTabState(tabId);
    const capturedAt = new Date().toISOString();
    state.lastRewrite = {
      capturedAt,
      endpoint: rewrite.endpoint ?? null,
      requestId: rewrite.requestId ?? null,
      fetchRequestId: rewrite.fetchRequestId ?? null,
      changed: Boolean(rewrite.changed),
      reason: rewrite.reason ?? null,
      modelBefore: rewrite.modelBefore ?? null,
      modelAfter: rewrite.modelAfter ?? null,
      transportModelBefore: rewrite.transportModelBefore ?? null,
      transportModelAfter: rewrite.transportModelAfter ?? null,
      reasoningBefore: rewrite.reasoningBefore ?? null,
      reasoningAfter: rewrite.reasoningAfter ?? null,
      reasoningFields: rewrite.reasoningFields ?? [],
      authorityKind: rewrite.authorityKind ?? null,
      authorityModel: rewrite.authorityModel ?? null,
      authorityStartedAt: rewrite.authorityStartedAt ?? null,
      error: rewrite.error ?? null,
    };
    if (rewrite.error) state.lastError = rewrite.error;
    // Fetch interception is the terminal request authority. Work-mode requests can
    // legitimately omit Network.requestWillBeSent's networkId at this boundary, so
    // retain the forwarded request as first-class verification evidence instead of
    // waiting forever for a Network requestId that may never be correlated.
    const discoveryAuthority = ['verification-transaction', 'model-discovery-native', 'model-discovery-chat-compat']
      .includes(rewrite.authorityKind);
    if (discoveryAuthority && rewrite.modelAfter && !rewrite.error) {
      state.lastForwardedRequest = {
        capturedAt,
        requestId: rewrite.requestId ?? null,
        fetchRequestId: rewrite.fetchRequestId ?? null,
        model: rewrite.modelAfter,
        transportModel: rewrite.transportModelAfter ?? null,
        authorityModel: rewrite.authorityModel ?? null,
      };
    }
    const verification = verificationTransactionForTab(tabId);
    if (verification?.model && !discoveryAuthority) {
      state.lastError = 'verification_request_missing_terminal_authority';
      state.phase = 'error';
      logRuntime('error', 'discovery', 'verification_request_generation_or_authority_mismatch', {
        tabId,
        verificationModel: verification.model,
        rewriteAuthorityKind: rewrite.authorityKind ?? null,
        rewriteAuthorityModel: rewrite.authorityModel ?? null,
        modelAfter: rewrite.modelAfter ?? null,
        fetchRequestId: rewrite.fetchRequestId ?? null,
      });
    }
    logRuntime(rewrite.error ? 'warn' : 'info', 'lock', rewrite.changed ? 'request_lock_rewritten' : 'request_lock_checked', {
      tabId,
      verificationActive: Boolean(verification),
      verificationModel: verification?.model ?? null,
      ...state.lastRewrite,
    });
    void broadcastTabState(tabId);
  },
  onRequest(tabId, request) {
    const state = ensureTabState(tabId);
    state.lastRequest = {
      requestId: request.requestId,
      capturedAt: request.capturedAt,
      model: request.model,
      reasoning: request.reasoning,
      diagnostics: request.diagnostics ?? null,
    };
    state.probeUsed = true;
    state.probeArmed = false;
    if (currentSettings.networkVerificationEnabled) state.phase = 'waiting';
    state.lastError = request.conflicts?.model || request.conflicts?.reasoning
      ? 'conflicting_request_metadata'
      : null;
    state.evidenceIssue = null;
    state.lastResponseEvidence = null;
    state.lastEvidenceDiagnostics = null;
    logRuntime('info', 'network', 'formal_conversation_request_detected', {
      tabId,
      requestId: request.requestId,
      model: request.model,
      reasoning: request.reasoning,
      conflicts: request.conflicts,
      fields: request.fields,
      diagnostics: request.diagnostics,
      responseVerificationEnabled: currentSettings.networkVerificationEnabled,
    });
    void broadcastTabState(tabId);
  },
  onEvidence(tabId, evidence) {
    void applyNetworkEvidence(tabId, evidence);
  },
  onStreamData(tabId, streamData) {
    const state = ensureTabState(tabId);
    if (streamData?.streamContext?.isDownstream) {
      const tracking = state.streamTracking || {
        detectedAt: Date.now(),
        lastActivityAt: Date.now(),
        downstreamEvidenceCount: 0,
        transports: [],
        handoff: null,
      };
      tracking.lastActivityAt = Date.now();
      const transport = streamData.streamContext.transport || streamData?.diagnostics?.transport || 'unknown';
      if (!tracking.transports.includes(transport)) tracking.transports.push(transport);
      state.streamTracking = tracking;
    }
    void captureAutoVerificationStream(tabId, state, streamData).catch((error) => {
      logRuntime('warn', 'diagnostics', 'auto_verify_stream_capture_failed', { tabId, error: errorText(error) });
    });
  },
  onFailure(tabId, failure) {
    logRuntime('error', 'network', 'response_loading_failed', {
      tabId,
      endpoint: failure.endpoint,
      httpStatus: failure.httpStatus,
      canceled: failure.canceled,
      error: failure.error,
    });
    if (failure.downstream || !masterRuntimeEnabled()) return;
    void applyNetworkEvidence(tabId, {
      requestId: failure.requestId,
      capturedAt: new Date().toISOString(),
      model: null,
      reasoning: null,
      conflicts: { model: false, reasoning: false },
      bodyError: failure.error,
      diagnostics: {
        endpoint: failure.endpoint,
        httpStatus: failure.httpStatus,
        bodyLength: 0,
        bodyFormat: 'empty',
        parsedObjectCount: 0,
      },
    });
  },
});

async function configureTab(tab) {
  if (!tab?.id || !isChatGptUrl(tab.url ?? '')) return;
  const state = ensureTabState(tab.id, tab.url);
  state.windowId = Number.isInteger(tab.windowId) ? tab.windowId : null;
  if (!masterRuntimeEnabled()) {
    await networkMonitor.detach(tab.id);
    try { await chrome.action.setBadgeText({ tabId: tab.id, text: '' }); } catch {}
    return state;
  }
  const enabled = effectiveSettingsForState(state).enabled;
  // Navigation from / to /c/:id is part of a new-chat verification turn. Detaching
  // CDP while ChatGPT creates that conversation loses the first formal request.
  if (verificationTransactionForTab(tab.id)) await networkMonitor.attach(tab.id);
  else if (!enabled || tab.status === 'loading') await networkMonitor.detach(tab.id);
  else await networkMonitor.attach(tab.id);
  await broadcastTabState(tab.id);
  return state;
}

async function configureOpenTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  // Keep browser-wide debugger work bounded. Concurrent account/window refreshes may
  // share per-tab single-flight tasks in ChatGptNetworkMonitor, while each sweep itself
  // advances one tab at a time instead of attaching every window in a Promise.all burst.
  for (const tab of tabs) await configureTab(tab);
}

async function refreshAccountHeartbeat({ reconfigure = true } = {}) {
  if (!accountClient.hasSession()) {
    serverFeatureSettingsReady = false;
    accountState = accountClient.snapshot();
    if (reconfigure) await configureOpenTabs();
    return accountState;
  }
  const chatTabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const windowKeys = [...new Set(chatTabs
    .filter((tab) => Number.isInteger(tab.windowId))
    .map((tab) => `chrome:${tab.windowId}`))];
  try {
    accountState = await accountClient.heartbeat(windowKeys);
    if (accountState?.authenticated === true) {
      await applyServerFeatureSettings();
    }
  } catch (error) {
    accountState = { ...accountClient.snapshot(), lastError: errorText(error) };
  }
  if (reconfigure) await configureOpenTabs();
  return accountState;
}

async function applyServerFeatureSettings() {
  if (!accountClient.hasSession()) return null;
  try {
    const data = await accountClient.clientControl();
    const control = data?.control;
    const remote = control?.featureSettings;
    if (!remote) return null;
    serverFeatureSettingsReady = true;
    const nextSettings = normalizeSettings({
      ...currentSettings,
      networkVerificationEnabled: remote.responseVerificationEnabled !== false,
      autoAlignSelection: remote.autoAlignSelection !== false,
      workModeGuidanceEnabled: remote.workModeGuidanceEnabled !== false,
      workModeFeatureEnabled: remote.workModeFeatureEnabled !== false,
    });
    const nextPolicy = normalizePolicy({ ...currentPolicy, strictMode: remote.strictMode === true });
    const settingsChanged = JSON.stringify(nextSettings) !== JSON.stringify(currentSettings);
    const policyChanged = JSON.stringify(nextPolicy) !== JSON.stringify(currentPolicy);
    const local = await chrome.storage.local.get(RUNTIME_LOG_SYNC_KEY);
    const runtimeLogSyncEnabled = remote.runtimeLogSyncEnabled === true;
    const logSyncChanged = local[RUNTIME_LOG_SYNC_KEY] !== runtimeLogSyncEnabled;
    if (settingsChanged || policyChanged) {
      await chrome.storage.sync.set({ settings: nextSettings, policy: nextPolicy });
      currentSettings = nextSettings;
      currentPolicy = nextPolicy;
    }
    if (logSyncChanged) {
      await chrome.storage.local.set({ [RUNTIME_LOG_SYNC_KEY]: runtimeLogSyncEnabled });
    }
    if (settingsChanged || policyChanged || logSyncChanged) {
      logRuntime('info', 'settings', 'server_client_settings_applied', {
        generation: remote.generation ?? null,
        responseVerificationEnabled: nextSettings.networkVerificationEnabled,
        autoAlignSelection: nextSettings.autoAlignSelection,
        workModeGuidanceEnabled: nextSettings.workModeGuidanceEnabled,
        workModeFeatureEnabled: nextSettings.workModeFeatureEnabled,
        strictMode: nextPolicy.strictMode,
        runtimeLogSyncEnabled,
      });
    }
    lastServerModelCatalogGeneration = Math.max(0, Number(control?.modelCatalogGeneration || 0));
    await syncSharedKnownModels({ serverGeneration: lastServerModelCatalogGeneration });
    return remote;
  } catch (error) {
    logRuntime('warn', 'settings', 'server_client_settings_fetch_failed', { error: errorText(error) });
    return null;
  }
}

async function refreshNativeCore({ tolerateFailure = false } = {}) {
  if (!masterRuntimeEnabled()) {
    await markNativeStopped();
    return { connected: false, error: null, status: null, reason: 'master_disabled' };
  }
  try {
    await sendNative('ping');
    await syncPolicy();
    const status = await sendNative('get_status');
    await writeNativeStatus({
      connected: true,
      lastError: null,
      lastSeenAt: new Date().toISOString(),
      lastVerification: status.lastVerification ?? null,
      policyRevision: status.policyRevision,
      version: status.version,
    });
    return { connected: true, error: null, status };
  } catch (error) {
    const detail = errorText(error);
    await writeNativeStatus({ connected: false, lastError: detail });
    if (!tolerateFailure) throw error;
    return { connected: false, error: detail, status: null };
  }
}

async function performInitialize() {
  const manifestVersion = chrome.runtime.getManifest().version;
  if (manifestVersion !== RUNTIME_CODE_VERSION) {
    await chrome.storage.local.set({
      gptworkGenerationMismatch: {
        manifestVersion,
        runtimeCodeVersion: RUNTIME_CODE_VERSION,
        detectedAt: new Date().toISOString(),
      },
    }).catch(() => {});
    // An unpacked extension can have its directory atomically replaced while the old
    // service worker is still alive. Never run a mixed generation: reload the whole
    // extension before attaching CDP or rewriting any request.
    chrome.runtime.reload();
    return;
  }
  logRuntime('info', 'extension', 'initialize_started', {
    version: manifestVersion,
    runtimeCodeVersion: RUNTIME_CODE_VERSION,
  });
  accountState = await accountClient.initialize();
  await ensureConfiguration();
  await syncSharedKnownModelsAfterRuntimeUpdate(manifestVersion).catch((error) => {
    logRuntime('warn', 'discovery', 'shared_model_catalog_version_sync_failed', {
      version: manifestVersion,
      error: errorText(error),
    });
  });
  if (!masterRuntimeEnabled()) {
    await stopBackgroundRuntime('initialize_master_disabled');
    await configureOpenTabs();
    logRuntime('info', 'extension', 'initialize_completed', {
      enabled: false,
      responseVerificationEnabled: currentSettings.networkVerificationEnabled,
      coreConnected: false,
      accountAuthenticated: Boolean(accountState?.authenticated),
      reason: 'master_disabled',
    });
    return;
  }
  await refreshNativeCore({ tolerateFailure: true });
  await refreshAccountHeartbeat({ reconfigure: false });
  await configureOpenTabs();
  chrome.alarms.create(ACCOUNT_REFRESH_ALARM, { periodInMinutes: 1 });
  logRuntime('info', 'extension', 'initialize_completed', {
    enabled: currentSettings.enabled,
    responseVerificationEnabled: currentSettings.networkVerificationEnabled,
    coreConnected: coreConnection.connected,
    accountAuthenticated: Boolean(accountState?.authenticated),
  });
}

function initialize() {
  if (initializeTask) return initializeTask;
  initializeTask = performInitialize().finally(() => {
    initializeTask = null;
  });
  return initializeTask;
}

async function refreshMasterRuntimeStateFromStorage() {
  const stored = await chrome.storage.local.get(LOCAL_ENABLED_KEY);
  const nextEnabled = stored?.[LOCAL_ENABLED_KEY];
  if (typeof nextEnabled === 'boolean') {
    localEnabledOverride = nextEnabled;
    currentSettings = normalizeSettings({ ...currentSettings, enabled: nextEnabled });
  }
  return masterRuntimeEnabled();
}

export async function initializeAfterCurrentTask({ refreshMasterFromStorage = false } = {}) {
  const current = initializeTask;
  if (current) {
    try { await current; } catch {}
  }
  // Update recovery writes Master=ON to storage before asking this lifecycle authority
  // to reconnect. Do not depend on storage.onChanged winning that race.
  if (refreshMasterFromStorage) await refreshMasterRuntimeStateFromStorage();
  if (!masterRuntimeEnabled()) return;
  await initialize();
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function chatGptTabId(preferred = null) {
  if (Number.isInteger(preferred)) {
    const tab = await chrome.tabs.get(preferred);
    if (isChatGptUrl(tab.url ?? '')) return preferred;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id && isChatGptUrl(active.url ?? '')) return active.id;
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  tabs.sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));
  return tabs[0]?.id ?? null;
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (response?.ok === false) reject(new Error(response.error || 'Page request failed'));
      else resolve(response);
    });
  });
}

function getPlatformInfo() {
  return new Promise((resolve) => {
    chrome.runtime.getPlatformInfo((info) => resolve(info ?? {}));
  });
}

async function collectPageObservation(tabId, state) {
  try {
    const response = await sendTabMessage(tabId, { type: 'GPTLOCK_COLLECT_PAGE_STATE' });
    if (response?.observation) {
      const observation = response.observation;
      state.pageObservation = {
        model: observation.model ?? null,
        reasoning: observation.reasoning ?? null,
        capturedAt: observation.capturedAt ?? new Date().toISOString(),
        evidenceSource: 'page_dom',
        modelEvidenceSource: observation.modelEvidenceSource ?? 'none',
        reasoningEvidenceSource: observation.reasoningEvidenceSource ?? 'none',
        modelLabel: observation.modelLabel ?? '',
        reasoningLabel: observation.reasoningLabel ?? '',
        ambiguousModel: Boolean(observation.ambiguousModel),
        candidates: Array.isArray(observation.candidates) ? observation.candidates.slice(0, 8) : [],
      };
      return { collected: true, error: null };
    }
    return { collected: false, error: 'page_observation_missing' };
  } catch (error) {
    return { collected: false, error: errorText(error) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetVerificationAttempt(state) {
  state.phase = 'initial';
  state.probeUsed = false;
  state.probeArmed = false;
  state.lastRewrite = null;
  state.lastRequest = null;
  state.lastForwardedRequest = null;
  state.lastVerification = null;
  state.lastResponseEvidence = null;
  state.lastEvidenceDiagnostics = null;
  state.streamTracking = null;
  state.evidenceIssue = null;
  state.lastError = null;
}

async function waitForAttemptVerification(tabId, startedAtMs) {
  const deadline = Date.now() + AUTO_VERIFY_RESPONSE_TIMEOUT_MS;
  let requestId = null;
  while (Date.now() < deadline) {
    const state = ensureTabState(tabId);
    const requestTime = Date.parse(state.lastRequest?.capturedAt || '');
    if (
      state.lastRequest?.requestId
      && Number.isFinite(requestTime)
      && requestTime >= startedAtMs - 1500
    ) requestId = state.lastRequest.requestId;

    if (
      requestId
      && state.lastVerification?.verdict === 'verified'
      && state.lastVerification?.requestId === `cdp-${tabId}-${requestId}`
    ) {
      return { timedOut: false, requestId, verified: true };
    }
    const tracking = state.streamTracking;
    if (requestId && tracking?.handoff) {
      const detectedAt = Number(tracking.detectedAt || 0);
      const lastActivityAt = Number(tracking.lastActivityAt || detectedAt);
      if (
        detectedAt
        && Date.now() - detectedAt >= AUTO_VERIFY_HANDOFF_MIN_WAIT_MS
        && Date.now() - lastActivityAt >= AUTO_VERIFY_HANDOFF_IDLE_MS
      ) {
        return {
          timedOut: false,
          requestId,
          handoffSettled: true,
          downstreamEvidenceCount: tracking.downstreamEvidenceCount || 0,
        };
      }
    } else if (
      requestId
      && state.lastVerification?.requestId === `cdp-${tabId}-${requestId}`
    ) {
      return { timedOut: false, requestId };
    }
    if (state.phase === 'error' && state.lastError) {
      return { timedOut: false, requestId, error: state.lastError };
    }
    await sleep(AUTO_VERIFY_POLL_MS);
  }
  return { timedOut: true, requestId };
}

function parseModelNameMappings(text, rawIds) {
  const source = String(text || '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    const allowedRaw = new Set(rawIds);
    return (Array.isArray(parsed?.mappings) ? parsed.mappings : [])
      .map((item) => ({
        raw: String(item?.raw || '').trim().toLowerCase(),
        canonical: normalizeConcreteModelId(item?.canonical),
        displayName: String(item?.displayName || '').trim().slice(0, 120),
      }))
      .filter((item) => allowedRaw.has(item.raw) && item.canonical);
  } catch {
    return [];
  }
}

async function resolveUnknownCatalogNames(tabId, rows) {
  const unresolved = rows.filter((item) => {
    const raw = String(item?.rawId || '').trim().toLowerCase();
    const canonical = normalizeConcreteModelId(item?.model || raw);
    return raw && raw === canonical && /(?:-wm|preview|experimental|beta)$/i.test(raw);
  });
  if (!unresolved.length) return [];
  const rawIds = [...new Set(unresolved.map((item) => String(item.rawId).trim().toLowerCase()))];
  const prompt = [
    'GPTWork 模型名称解析：下面是从当前 ChatGPT 账户模型元数据自动发现、但 GPTWork 尚未定义显示名称的原始 model ID：',
    rawIds.join(', '),
    '请仅返回 JSON，不要解释。格式：{"mappings":[{"raw":"原始ID","canonical":"稳定的规范model ID","displayName":"ChatGPT界面正式模型名称"}]}。',
    '如果无法确定，canonical 请保持与 raw 完全相同，不要猜测。',
  ].join('\n');
  try {
    const result = await sendTabMessage(tabId, { type: 'GPTLOCK_AUTO_RESOLVE_MODEL_NAMES', prompt });
    const mappings = parseModelNameMappings(result?.responseText, rawIds);
    if (mappings.length) {
      const stored = await chrome.storage.sync.get('gptworkModelNameMappingsV1');
      const previous = stored.gptworkModelNameMappingsV1 && typeof stored.gptworkModelNameMappingsV1 === 'object'
        ? stored.gptworkModelNameMappingsV1
        : {};
      const next = { ...previous };
      for (const item of mappings) next[item.raw] = { canonical: item.canonical, displayName: item.displayName, learnedAt: new Date().toISOString() };
      await chrome.storage.sync.set({ gptworkModelNameMappingsV1: next });
    }
    logRuntime('info', 'discovery', 'model_name_fallback_completed', { tabId, rawIds, mappings });
    return mappings;
  } catch (error) {
    logRuntime('warn', 'discovery', 'model_name_fallback_failed', { tabId, rawIds, error: errorText(error) });
    return [];
  }
}

function sharedModelClientEligible(item) {
  if (item?.clientEligible === true || Number(item?.clientEligibleAccountCount || 0) > 0) return true;
  return Number(item?.discoveredCount || 0) > 0
    && Number(item?.requestConfirmedAccountCount || 0) > 0
    && Number(item?.verifiedAccountCount || 0) > 0
    && Number(item?.chatLockVerifiedAccountCount || 0) > 0;
}

function normalizeClientSharedModels(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      model: normalizeConcreteModelId(item?.model),
      label: String(item?.label || '').trim().slice(0, 120),
      pickerMode: ['A', 'B'].includes(item?.pickerMode) ? item.pickerMode : null,
      nativeRequestModel: normalizeRawProtocolModelId(item?.nativeRequestModel),
      nativeResponseModel: normalizeRawProtocolModelId(item?.nativeResponseModel),
      chatTransportModel: normalizeRawProtocolModelId(item?.chatTransportModel),
      chatResponseModel: normalizeRawProtocolModelId(item?.chatResponseModel),
      discoveredCount: Math.max(0, Number(item?.discoveredCount || 0)),
      requestConfirmedAccountCount: Math.max(0, Number(item?.requestConfirmedAccountCount || 0)),
      verifiedCount: Math.max(0, Number(item?.verifiedCount || 0)),
      verifiedAccountCount: Math.max(0, Number(item?.verifiedAccountCount || 0)),
      chatLockVerifiedCount: Math.max(0, Number(item?.chatLockVerifiedCount || 0)),
      chatLockVerifiedAccountCount: Math.max(0, Number(item?.chatLockVerifiedAccountCount || 0)),
      clientEligibleAccountCount: Math.max(0, Number(item?.clientEligibleAccountCount || 0)),
      clientEligible: item?.clientEligible === true,
      lastSeenAt: item?.lastSeenAt || null,
    }))
    .filter((item) => item.model && sharedModelClientEligible(item));
}

async function applyClientSharedModelCatalog(rawModels, {
  generation = 0,
  accountId = Number(accountState?.user?.id || 0),
  reason = 'sync',
} = {}) {
  const stored = await chrome.storage.sync.get([SHARED_KNOWN_MODELS_KEY, 'policy']);
  const previous = Array.isArray(stored[SHARED_KNOWN_MODELS_KEY]) ? stored[SHARED_KNOWN_MODELS_KEY] : [];
  const models = normalizeClientSharedModels(rawModels);
  const allowed = new Set(models.map((item) => item.model));
  const policy = normalizePolicy(stored.policy);
  const lockedModels = policy.lockedModels.filter((model) => allowed.has(model));
  const workDefaultModel = allowed.has(policy.workDefaultModel)
    ? policy.workDefaultModel
    : lockedModels[0] || models[0]?.model || policy.workDefaultModel;
  const nextPolicy = normalizePolicy({ ...policy, lockedModels, workDefaultModel });

  const patch = {};
  if (JSON.stringify(previous) !== JSON.stringify(models)) patch[SHARED_KNOWN_MODELS_KEY] = models;
  if (JSON.stringify(policy) !== JSON.stringify(nextPolicy)) patch.policy = nextPolicy;
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
  currentPolicy = nextPolicy;

  sharedKnownModelIds = new Set(models.map((item) => item.model).filter(Boolean));
  sharedModelProtocolMap = new Map(models
    .map((item) => ({
      model: item.model,
      transport: item.chatTransportModel,
    }))
    .filter((item) => item.model && item.transport)
    .map((item) => [item.model, item.transport]));
  rememberProvenPickerBChatModels(models);

  await chrome.storage.local.set({
    [SHARED_MODEL_CATALOG_GENERATION_KEY]: Math.max(0, Number(generation || 0)),
    [SHARED_MODEL_CATALOG_ACCOUNT_KEY]: accountId,
  });
  lastServerModelCatalogGeneration = Math.max(lastServerModelCatalogGeneration ?? 0, Math.max(0, Number(generation || 0)));
  logRuntime('info', 'discovery', 'shared_model_catalog_client_applied', {
    count: models.length,
    previousCount: previous.length,
    lockedBefore: policy.lockedModels.length,
    lockedAfter: nextPolicy.lockedModels.length,
    prunedLockedModels: policy.lockedModels.filter((model) => !allowed.has(model)),
    generation: Math.max(0, Number(generation || 0)),
    reason,
  });
  return models;
}

async function syncSharedKnownModels({ serverGeneration = lastServerModelCatalogGeneration, force = false } = {}) {
  const [storedModels, local] = await Promise.all([
    chrome.storage.sync.get(SHARED_KNOWN_MODELS_KEY),
    chrome.storage.local.get([SHARED_MODEL_CATALOG_GENERATION_KEY, SHARED_MODEL_CATALOG_ACCOUNT_KEY]),
  ]);
  const cachedRaw = Array.isArray(storedModels[SHARED_KNOWN_MODELS_KEY]) ? storedModels[SHARED_KNOWN_MODELS_KEY] : [];
  const cached = normalizeClientSharedModels(cachedRaw);
  const accountId = Number(accountState?.user?.id || 0);
  const syncedAccountId = Number(local[SHARED_MODEL_CATALOG_ACCOUNT_KEY] || 0);
  const hasSyncedGeneration = Number.isInteger(Number(local[SHARED_MODEL_CATALOG_GENERATION_KEY]));
  const syncedGeneration = hasSyncedGeneration ? Math.max(0, Number(local[SHARED_MODEL_CATALOG_GENERATION_KEY])) : -1;
  const requestedGeneration = serverGeneration === null || serverGeneration === undefined
    ? null
    : Math.max(0, Number(serverGeneration || 0));
  const accountChanged = accountId > 0 && syncedAccountId !== accountId;
  const generationChanged = requestedGeneration !== null && syncedGeneration < requestedGeneration;
  const needsInitialSync = !hasSyncedGeneration || syncedAccountId <= 0;

  sharedKnownModelIds = new Set(cached.map((item) => item.model).filter(Boolean));
  sharedModelProtocolMap = new Map(cached
    .map((item) => ({ model: item.model, transport: item.chatTransportModel }))
    .filter((item) => item.model && item.transport)
    .map((item) => [item.model, item.transport]));
  rememberProvenPickerBChatModels(cached);

  if (!force && !accountChanged && !generationChanged && !needsInitialSync) {
    if (JSON.stringify(cachedRaw) !== JSON.stringify(cached)) {
      return applyClientSharedModelCatalog(cached, {
        generation: syncedGeneration,
        accountId,
        reason: 'cached_four_gate_cleanup',
      });
    }
    return cached;
  }
  if (Date.now() < sharedModelCatalogUnavailableUntil) return cached;

  try {
    const result = await accountClient.sharedModelCatalog();
    const generation = Math.max(0, Number(result?.generation || 0));
    const models = await applyClientSharedModelCatalog(result?.models, {
      generation,
      accountId,
      reason: accountChanged ? 'account_first_login' : generationChanged ? 'server_generation_changed' : needsInitialSync ? 'initial_sync' : 'forced',
    });
    logRuntime('info', 'discovery', 'shared_model_catalog_synced', {
      count: models.length,
      generation,
      fourGateOnly: true,
      reason: accountChanged ? 'account_first_login' : generationChanged ? 'server_generation_changed' : needsInitialSync ? 'initial_sync' : 'forced',
    });
    return models;
  } catch (error) {
    const unsupported = Number(error?.status) === 404 || /not found/i.test(errorText(error));
    if (unsupported) sharedModelCatalogUnavailableUntil = Date.now() + 5 * 60 * 1000;
    logRuntime(unsupported ? 'info' : 'warn', 'discovery', unsupported ? 'shared_model_catalog_unavailable' : 'shared_model_catalog_sync_failed', {
      error: errorText(error), retryAfterMs: unsupported ? 5 * 60 * 1000 : 0,
    });
    return cached;
  }
}

async function syncSharedKnownModelsAfterRuntimeUpdate(manifestVersion) {
  if (accountState?.authenticated !== true) return [];
  const local = await chrome.storage.local.get(SHARED_MODEL_CATALOG_SYNC_VERSION_KEY);
  if (local[SHARED_MODEL_CATALOG_SYNC_VERSION_KEY] === manifestVersion) return [];
  const models = await syncSharedKnownModels({ force: true });
  await chrome.storage.local.set({ [SHARED_MODEL_CATALOG_SYNC_VERSION_KEY]: manifestVersion });
  logRuntime('info', 'discovery', 'shared_model_catalog_version_sync_completed', {
    version: manifestVersion,
    count: models.length,
  });
  return models;
}

function mergeAccountCatalogs(...catalogs) {
  const rows = [];
  const seen = new Set();
  const models = new Set();
  const reasoningLevels = new Set();
  let pickerMode = null;
  for (const catalog of catalogs.filter(Boolean)) {
    if (['A', 'B'].includes(catalog?.pickerMode)) pickerMode = catalog.pickerMode;
    for (const level of catalog?.reasoningLevels || []) reasoningLevels.add(level);
    for (const row of catalog?.rows || []) {
      const model = normalizeConcreteModelId(row?.model || row?.rawId);
      const selectorKey = String(row?.selectorKey || '').trim();
      const label = String(row?.label || '').trim();
      const key = model ? 'model:' + model : selectorKey ? 'selector:' + selectorKey : 'label:' + label;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (model) models.add(model);
      rows.push({ ...row, pickerMode: row?.pickerMode || catalog?.pickerMode || null });
    }
  }
  return { rows, models: [...models], reasoningLevels: [...reasoningLevels], pickerMode };
}

function networkCandidateCatalog(items, source = 'network-candidate') {
  const rows = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const raw = typeof item === 'string' ? item : (item?.model || item?.rawId);
    const model = normalizeConcreteModelId(raw);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    rows.push({
      model,
      rawId: model,
      label: String(typeof item === 'string' ? model : (item?.label || model)).trim().slice(0, 160),
      selectorKey: NETWORK_CANDIDATE_SELECTOR,
      pickerMode: null,
      discoverySource: source,
    });
  }
  return {
    rows,
    models: rows.map((row) => row.model),
    reasoningLevels: [],
    pickerMode: null,
  };
}

async function loadTrustedLocalNetworkCandidates() {
  const stored = await chrome.storage.sync.get([LOCAL_DISCOVERED_MODELS_KEY, LOCAL_DISCOVERED_EVIDENCE_KEY]);
  const models = Array.isArray(stored[LOCAL_DISCOVERED_MODELS_KEY]) ? stored[LOCAL_DISCOVERED_MODELS_KEY] : [];
  const evidence = stored[LOCAL_DISCOVERED_EVIDENCE_KEY] && typeof stored[LOCAL_DISCOVERED_EVIDENCE_KEY] === 'object'
    ? stored[LOCAL_DISCOVERED_EVIDENCE_KEY]
    : {};
  return models
    .map((value) => normalizeConcreteModelId(value))
    .filter(Boolean)
    .filter((model) => {
      const sources = Array.isArray(evidence?.[model]?.sources) ? evidence[model].sources : [];
      return sources.includes('network_request_metadata') || sources.includes('network_response_metadata');
    })
    .map((model) => ({ model, label: model }));
}

async function broadcastVerificationState(executionTabId, ownerTabId) {
  await broadcastTabState(executionTabId);
  if (Number.isInteger(ownerTabId) && ownerTabId !== executionTabId) {
    await broadcastTabState(ownerTabId);
  }
}

async function broadcastVerificationTabs(executionTabId, ownerTabId, additionalTabIds = []) {
  await broadcastVerificationState(executionTabId, ownerTabId);
  const already = new Set([Number(executionTabId), Number(ownerTabId)].filter(Number.isInteger));
  for (const tabId of Array.isArray(additionalTabIds) ? additionalTabIds.map(Number) : []) {
    if (!Number.isInteger(tabId) || already.has(tabId)) continue;
    already.add(tabId);
    await broadcastTabState(tabId);
  }
}

async function verificationSurfaceStatus(tabId) {
  return sendTabMessage(tabId, { type: 'GPTLOCK_VERIFICATION_SURFACE_STATUS' }).catch((error) => ({
    ok: false,
    ready: false,
    structuralReady: false,
    contentRuntimeReady: false,
    composerReady: false,
    modelTriggerReady: false,
    documentVisible: false,
    reason: errorText(error),
  }));
}

async function waitForVerificationSurface(tabId, timeoutMs, { requireVisible = true } = {}) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 0));
  let last = {
    ready: false,
    structuralReady: false,
    contentRuntimeReady: false,
    composerReady: false,
    modelTriggerReady: false,
    documentVisible: false,
    reason: 'content_runtime_unavailable',
  };
  let recoveryAttempted = false;
  do {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ...last, reason: 'verification_tab_closed' };

    // ChatGPT is an SPA: the composer/content runtime can be fully usable while
    // chrome.tabs still reports status="loading". Never gate the page handshake on
    // tab.status === "complete"; the page runtime itself is the readiness authority.
    last = await verificationSurfaceStatus(tabId);
    let structuralReady = last?.contentRuntimeReady === true
      && last?.composerReady === true
      && last?.modelTriggerReady === true;
    if (structuralReady && (!requireVisible || last?.documentVisible === true)) {
      return { ...last, ready: true, structuralReady: true };
    }

    // If the page really has no receiver after navigation is complete, invoke the
    // single content-runtime recovery authority once instead of waiting for a
    // tab-activation/onUpdated race to happen to inject it.
    if (
      !recoveryAttempted
      && last?.contentRuntimeReady !== true
      && tab.status === 'complete'
      && isChatGptUrl(tab.url || '')
    ) {
      recoveryAttempted = true;
      const recovery = await ensureContentRuntime(tabId, 'verification_surface_wait');
      if (recovery?.ready === true) {
        last = await verificationSurfaceStatus(tabId);
        structuralReady = last?.contentRuntimeReady === true
          && last?.composerReady === true
          && last?.modelTriggerReady === true;
        if (structuralReady && (!requireVisible || last?.documentVisible === true)) {
          return { ...last, ready: true, structuralReady: true };
        }
      }
    }

    await sleep(250);
  } while (Date.now() < deadline);
  return {
    ...last,
    ready: false,
    structuralReady: Boolean(last?.contentRuntimeReady && last?.composerReady && last?.modelTriggerReady),
    reason: last?.reason || 'verification_surface_not_ready',
  };
}

async function createVerificationExecutionTab(sourceTabId) {
  const sourceTab = await chrome.tabs.get(sourceTabId).catch(() => null);
  if (!sourceTab?.id || !Number.isInteger(sourceTab.windowId)) {
    throw new Error('Source ChatGPT tab is unavailable');
  }

  const activeTabs = await chrome.tabs.query({ windowId: sourceTab.windowId, active: true }).catch(() => []);
  const restoreActiveTabId = Number(activeTabs?.[0]?.id) || sourceTabId;
  let verificationTab = null;
  let verificationTabId = null;
  let activatedForReadiness = false;
  try {
    verificationTab = await chrome.tabs.create({
      windowId: sourceTab.windowId,
      url: 'https://chatgpt.com/',
      active: false,
    });
    verificationTabId = Number(verificationTab?.id);
    if (!Number.isInteger(verificationTabId)) throw new Error('Temporary verification tab was not created');

    await isolateTabForVerification(verificationTabId);
    logRuntime('info', 'discovery', 'verification_surface_tab_created', {
      sourceTabId,
      verificationTabId,
      active: false,
    });

    let surface = await waitForVerificationSurface(verificationTabId, 3000, { requireVisible: false });
    if (surface?.ready !== true || surface?.documentVisible !== true) {
      await chrome.tabs.update(verificationTabId, { active: true }).catch(() => null);
      activatedForReadiness = true;
      logRuntime('info', 'discovery', 'verification_surface_activation_fallback', {
        sourceTabId,
        verificationTabId,
        reason: surface?.reason || (surface?.structuralReady ? 'document_hidden' : 'surface_not_ready_in_background'),
      });
      surface = await waitForVerificationSurface(verificationTabId, 9000, { requireVisible: true });
    }

    if (surface?.ready !== true) {
      return {
        sourceTabId,
        verificationTabId,
        verificationTab,
        restoreActiveTabId,
        activatedForReadiness,
        surface,
        ready: false,
      };
    }

    logRuntime('info', 'discovery', 'verification_surface_ready', {
      sourceTabId,
      verificationTabId,
      composerReady: surface.composerReady === true,
      modelTriggerReady: surface.modelTriggerReady === true,
      documentVisible: surface.documentVisible === true,
      pathname: surface.pathname || null,
    });
    return {
      sourceTabId,
      verificationTabId,
      verificationTab,
      restoreActiveTabId,
      activatedForReadiness,
      surface,
      ready: true,
    };
  } catch (error) {
    if (activatedForReadiness && Number.isInteger(restoreActiveTabId) && restoreActiveTabId !== verificationTabId) {
      await chrome.tabs.update(restoreActiveTabId, { active: true }).catch(() => null);
    }
    if (Number.isInteger(verificationTabId)) {
      await chrome.tabs.remove(verificationTabId).catch(() => null);
    }
    logRuntime('warn', 'discovery', 'verification_surface_tab_create_failed', {
      sourceTabId,
      verificationTabId,
      error: errorText(error),
    });
    throw error;
  }
}

async function closeVerificationExecutionTab(session) {
  const verificationTabId = Number(session?.verificationTabId);
  const restoreActiveTabId = Number(session?.restoreActiveTabId);
  if (Number.isInteger(verificationTabId)) {
    await networkMonitor.disableResponseCapture(verificationTabId).catch(() => {});
    await networkMonitor.detach(verificationTabId).catch(() => {});
  }
  if (
    session?.activatedForReadiness === true
    && Number.isInteger(restoreActiveTabId)
    && restoreActiveTabId !== verificationTabId
  ) {
    await chrome.tabs.update(restoreActiveTabId, { active: true }).catch(() => null);
  }
  if (Number.isInteger(verificationTabId)) {
    await chrome.tabs.remove(verificationTabId).catch(() => null);
    logRuntime('info', 'discovery', 'verification_surface_tab_closed', {
      sourceTabId: Number(session?.sourceTabId) || null,
      verificationTabId,
      restoredActiveTabId: session?.activatedForReadiness === true ? restoreActiveTabId : null,
    });
  }
}

async function enterNativeWorkOnDiscoveryTab(tabId, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 0));
  let last = { entered: false, actuated: false, reason: 'content_runtime_unavailable' };
  let recoveryAttempted = false;
  do {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ...last, reason: 'discovery_tab_closed' };

    // As with the verification surface, ChatGPT's SPA can accept content-runtime
    // messages before chrome.tabs reports status="complete". Ask the page directly.
    const response = await sendTabMessage(tabId, { type: 'GPTLOCK_VERIFY_ENTER_WORK_MODE' }).catch((error) => ({
      ok: false,
      attempted: false,
      actuated: false,
      reason: errorText(error),
    }));
    last = {
      entered: response?.ok === true && (response?.confirmed === true || response?.alreadySelected === true),
      reason: response?.reason || null,
      attempted: response?.attempted === true,
      actuated: response?.actuated === true,
      alreadySelected: response?.alreadySelected === true,
      confirmed: response?.confirmed === true,
      surfaceEvidence: response?.surfaceEvidence || null,
    };
    if (last.entered || last.actuated) return last;

    if (
      !recoveryAttempted
      && tab.status === 'complete'
      && isChatGptUrl(tab.url || '')
      && /receiving end does not exist|content_runtime_unavailable/i.test(String(last.reason || ''))
    ) {
      recoveryAttempted = true;
      await ensureContentRuntime(tabId, 'official_work_entry_wait').catch(() => null);
    }
    await sleep(300);
  } while (Date.now() < deadline);
  return { ...last, entered: false, reason: last?.reason || 'native_work_surface_not_ready' };
}

function successfulConversationResponseEvidence(evidence) {
  if (!evidence || evidence?.conflicts?.model) return false;
  const status = Number(evidence?.diagnostics?.httpStatus || evidence?.status || 0);
  const parsedObjectCount = Number(evidence?.diagnostics?.parsedObjectCount || 0);
  const streamCaptureBytes = Number(evidence?.diagnostics?.streamCaptureBytes || 0);
  const rawBodyLength = typeof evidence?.rawResponseBody === 'string' ? evidence.rawResponseBody.length : 0;
  return status >= 200
    && status < 300
    && !evidence?.bodyError
    && (parsedObjectCount > 0 || streamCaptureBytes > 0 || rawBodyLength > 0);
}

async function waitForNetworkModelEvidence(
  tabId,
  startedAtMs,
  timeoutMs = AUTO_VERIFY_RESPONSE_TIMEOUT_MS,
  { allowModelMissing = false } = {},
) {
  const deadline = Date.now() + Math.max(1500, Number(timeoutMs || 0));
  let requestId = null;
  while (Date.now() < deadline) {
    const state = ensureTabState(tabId);
    const requestTime = Date.parse(state.lastRequest?.capturedAt || '');
    if (
      state.lastRequest?.requestId
      && Number.isFinite(requestTime)
      && requestTime >= startedAtMs - 1500
    ) requestId = state.lastRequest.requestId;

    const evidence = state.lastResponseEvidence;
    const matchingResponse = Boolean(
      requestId
      && evidence?.requestId === requestId
      && !evidence?.conflicts?.model
    );
    if (
      matchingResponse
      && (
        evidence?.rawModel
        || evidence?.model
        || (allowModelMissing && successfulConversationResponseEvidence(evidence))
      )
    ) {
      return { timedOut: false, requestId, evidence };
    }
    await sleep(150);
  }
  return { timedOut: true, requestId, evidence: null };
}

async function discoverOfficialWorkModels(sourceTabId, progress) {
  const ownerTabId = Number.isInteger(progress?.ownerTabId) ? progress.ownerTabId : sourceTabId;
  const sourceTab = await chrome.tabs.get(sourceTabId).catch(() => null);
  if (!sourceTab?.id || !Number.isInteger(sourceTab.windowId)) {
    logRuntime('warn', 'discovery', 'official_work_model_discovery_unavailable', {
      sourceTabId,
      reason: 'source_tab_unavailable',
    });
    return { pickerMode: 'B', rows: [], models: [], nativeResults: [], chatCandidates: { pickerMode: 'B', rows: [], models: [], reasoningLevels: [] } };
  }

  const activeTabs = await chrome.tabs.query({ windowId: sourceTab.windowId, active: true }).catch(() => []);
  const restoreActiveTabId = Number(activeTabs?.[0]?.id) || null;
  let discoveryTab = null;
  let activatedForReadiness = false;
  let discoveryTabId = null;
  try {
    discoveryTab = await chrome.tabs.create({
      windowId: sourceTab.windowId,
      url: 'https://chatgpt.com/',
      active: false,
    });
    discoveryTabId = Number(discoveryTab?.id);
    if (!Number.isInteger(discoveryTabId)) throw new Error('Temporary official Work discovery tab was not created');
    await isolateTabForNativeDiscovery(discoveryTabId);

    const sourceState = ensureTabState(sourceTabId, sourceTab.url || 'https://chatgpt.com/');
    const discoveryState = ensureTabState(discoveryTabId, discoveryTab.url || 'https://chatgpt.com/');
    discoveryState.windowId = sourceTab.windowId;
    if (sourceState.autoVerification?.running === true) {
      discoveryState.autoVerification = sourceState.autoVerification;
    }
    await broadcastVerificationTabs(sourceTabId, ownerTabId, [discoveryTabId]);

    logRuntime('info', 'discovery', 'official_work_model_discovery_tab_created', {
      sourceTabId,
      discoveryTabId,
      active: false,
    });

    let enter = await enterNativeWorkOnDiscoveryTab(discoveryTabId, 9000);
    if (enter?.entered !== true) {
      await chrome.tabs.update(discoveryTabId, { active: true }).catch(() => null);
      activatedForReadiness = true;
      logRuntime('info', 'discovery', 'official_work_model_discovery_activation_fallback', {
        sourceTabId,
        discoveryTabId,
        reason: enter?.reason || 'official_work_control_not_ready_in_background',
      });
      enter = await enterNativeWorkOnDiscoveryTab(discoveryTabId, 6500);
    }

    if (enter?.entered !== true && enter?.actuated !== true) {
      logRuntime('warn', 'discovery', 'official_work_model_discovery_unavailable', {
        sourceTabId,
        discoveryTabId,
        reason: enter?.reason || 'official_work_control_not_found',
      });
      return { pickerMode: 'B', rows: [], models: [], nativeResults: [], chatCandidates: { pickerMode: 'B', rows: [], models: [], reasoningLevels: [] } };
    }

    // The current ChatGPT home toggle does not expose aria-selected/aria-pressed/data-state
    // on its Work button. A trusted click is therefore only an actuation witness. Picker-B
    // topology is the authoritative proof that the official Work surface actually opened.
    if (enter?.entered !== true && enter?.actuated === true) {
      logRuntime('info', 'discovery', 'official_work_control_actuated_unconfirmed', {
        sourceTabId,
        discoveryTabId,
        reason: enter?.reason || 'work_control_actuated_unconfirmed',
        surfaceEvidence: enter?.surfaceEvidence || null,
      });
    }

    const attached = await networkMonitor.attach(discoveryTabId);
    const responseCaptureReady = attached
      ? await networkMonitor.enableResponseCapture(discoveryTabId).catch(() => false)
      : false;
    if (!attached || !responseCaptureReady) throw new Error('Official Work network capture unavailable');

    const scanForPickerB = async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      let latest = null;
      do {
        latest = await discoverAccountCatalog(discoveryTabId);
        progress.discoveryPasses += 1;
        if (latest?.pickerMode === 'B' && Array.isArray(latest?.rows) && latest.rows.length) return latest;
        await sleep(450);
      } while (Date.now() < deadline);
      return latest;
    };

    await sleep(700);
    let discovered = await scanForPickerB(3600);
    if (
      discovered?.pickerMode === 'B'
      && Array.isArray(discovered?.rows)
      && discovered.rows.length
      && enter?.entered !== true
    ) {
      enter = { ...enter, entered: true, confirmed: true, reason: 'picker_b_topology_confirmed' };
      logRuntime('info', 'discovery', 'official_work_surface_confirmed_by_picker_b', {
        sourceTabId,
        discoveryTabId,
        candidateCount: discovered.rows.length,
        models: discovered.rows.map((row) => normalizeConcreteModelId(row?.model || row?.rawId)).filter(Boolean),
      });
    }

    if (enter?.entered !== true && discovered?.pickerMode !== 'B') {
      logRuntime('warn', 'discovery', 'official_work_model_discovery_unavailable', {
        sourceTabId,
        discoveryTabId,
        reason: 'work_surface_not_confirmed_by_picker_b',
        controlReason: enter?.reason || null,
        pickerMode: discovered?.pickerMode ?? null,
      });
      return { pickerMode: 'B', rows: [], models: [], nativeResults: [], chatCandidates: { pickerMode: 'B', rows: [], models: [], reasoningLevels: [] } };
    }

    let bootstrapSent = false;
    if (discovered?.pickerMode !== 'B') {
      verificationTransactions.set(discoveryTabId, {
        model: 'gpt-5.6-sol',
        mode: 'observe-native',
        selectorKey: '__official_work_bootstrap__',
        label: 'Official Work bootstrap',
        startedAt: Date.now(),
      });
      try {
        resetVerificationAttempt(ensureTabState(discoveryTabId));
        const probe = await sendVerificationReasoningProbe(
          discoveryTabId,
          'GPTWork 发现模型 · Official Work bootstrap',
          1,
          1,
        );
        bootstrapSent = probe?.sent === true;
        if (bootstrapSent) {
          await sendTabMessage(discoveryTabId, {
            type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED',
            assistantCountBefore: probe.assistantCountBefore ?? 0,
            timeoutMs: AUTO_VERIFY_RESPONSE_TIMEOUT_MS,
          }).catch(() => null);
          discovered = await scanForPickerB(6000);
        }
      } finally {
        verificationTransactions.delete(discoveryTabId);
      }
    }

    if (discovered?.pickerMode !== 'B' || !Array.isArray(discovered?.rows) || !discovered.rows.length) {
      logRuntime('warn', 'discovery', 'official_work_picker_b_empty', {
        sourceTabId,
        discoveryTabId,
        entered: enter?.entered === true,
        bootstrapSent,
        pickerMode: discovered?.pickerMode ?? null,
      });
      return { pickerMode: 'B', rows: [], models: [], nativeResults: [], chatCandidates: { pickerMode: 'B', rows: [], models: [], reasoningLevels: [] } };
    }

    const nativeResults = [];
    const rows = discovered.rows.map((row) => ({ ...row, pickerMode: 'B', discoverySource: 'official-work-picker-b' }));
    progress.activeStage = {
      id: 'picker-b-work',
      label: 'Picker B · ChatGPT Work',
      total: rows.length,
      completed: 0,
      verified: 0,
      requestConfirmed: 0,
      currentModel: null,
      currentLabel: '正在验证 Picker B（Work）',
    };
    await broadcastVerificationTabs(sourceTabId, ownerTabId, [discoveryTabId]);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const model = normalizeConcreteModelId(row?.model || row?.rawId);
      if (!model) continue;
      const liveStateBefore = ensureTabState(discoveryTabId);
      resetVerificationAttempt(liveStateBefore);
      progress.activeStage = {
        ...progress.activeStage,
        completed: index,
        verified: nativeResults.filter((item) => item.nativeVerified).length,
        requestConfirmed: nativeResults.filter((item) => item.nativeRequestConfirmed).length,
        currentModel: model,
        currentLabel: String(row.label || model),
      };
      progress.currentModel = model;
      progress.currentSelectorKey = String(row.selectorKey || '');
      progress.currentLabel = String(row.label || model);
      const startedAtMs = Date.now();
      verificationTransactions.set(discoveryTabId, {
        model,
        mode: 'observe-native',
        selectorKey: String(row.selectorKey || ''),
        label: String(row.label || model),
        startedAt: startedAtMs,
      });
      await broadcastVerificationTabs(sourceTabId, ownerTabId, [discoveryTabId]);
      logRuntime('info', 'discovery', 'official_work_model_native_started', {
        sourceTabId,
        discoveryTabId,
        index: index + 1,
        total: rows.length,
        model,
        label: String(row.label || model),
        selectorKey: String(row.selectorKey || ''),
      });
      try {
        const selectionResponse = await sendTabMessage(discoveryTabId, {
          type: 'GPTLOCK_VERIFY_ACCOUNT_MODEL',
          model,
          selectorKey: row.selectorKey,
          label: row.label,
        });
        const selection = selectionResponse?.result || {};
        if (selection.selectionAttempted !== true) throw new Error('Official Work Picker-B model selection was not activated');

        await sleep(1200);
        const reattached = await networkMonitor.attach(discoveryTabId);
        if (!reattached || !await networkMonitor.enableResponseCapture(discoveryTabId)) {
          throw new Error('Official Work response capture did not re-enable');
        }
        const probe = await sendVerificationReasoningProbe(
          discoveryTabId,
          'GPTWork 发现模型 · Official Work native',
          index + 1,
          rows.length,
        );
        if (!probe?.sent) throw new Error('Official Work discovery probe was not sent');

        const [networkEvidence, settled] = await Promise.all([
          waitForNetworkModelEvidence(
            discoveryTabId,
            startedAtMs,
            AUTO_VERIFY_RESPONSE_TIMEOUT_MS,
            { allowModelMissing: true },
          ),
          sendTabMessage(discoveryTabId, {
            type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED',
            assistantCountBefore: probe.assistantCountBefore ?? 0,
            timeoutMs: AUTO_VERIFY_RESPONSE_TIMEOUT_MS,
          }).catch(() => null),
        ]);
        const liveState = ensureTabState(discoveryTabId);
        const rawRequestModel = normalizeRawProtocolModelId(
          liveState.lastRewrite?.transportModelAfter
            || liveState.lastRewrite?.transportModelBefore
            || liveState.lastRequest?.rawModel,
        );
        const responseEvidence = networkEvidence?.evidence
          || (liveState.lastResponseEvidence?.requestId === networkEvidence?.requestId ? liveState.lastResponseEvidence : null);
        const rawResponseModel = normalizeRawProtocolModelId(
          responseEvidence?.rawModel
            || responseEvidence?.model,
        );
        const nativeRequestConfirmed = Boolean(rawRequestModel);
        const nativeResponseConfirmed = Boolean(rawResponseModel);
        const nativeResponseObserved = successfulConversationResponseEvidence(responseEvidence);
        const nativeResponseCompatible = !rawResponseModel
          || normalizeConcreteModelId(rawResponseModel) === model;
        const nativeVerified = selection.selectionAttempted === true
          && nativeRequestConfirmed
          && nativeResponseObserved
          && nativeResponseCompatible
          && settled?.settled === true;

        const result = {
          model,
          label: String(row.label || model),
          selectorKey: String(row.selectorKey || ''),
          pickerMode: 'B',
          discoverySource: 'official-work-picker-b',
          nativeRequestModel: rawRequestModel,
          nativeResponseModel: rawResponseModel,
          nativeRequestConfirmed,
          nativeResponseConfirmed,
          nativeResponseObserved,
          nativeResponseCompatible,
          nativeVerificationBasis: nativeResponseConfirmed
            ? 'request_transport+response_model'
            : nativeResponseObserved
              ? 'request_transport+response_stream'
              : null,
          nativeVerified,
          requestId: networkEvidence?.requestId || liveState.lastRequest?.requestId || null,
        };
        nativeResults.push(result);
        logRuntime(nativeVerified ? 'info' : 'warn', 'discovery', 'official_work_model_native_verified', {
          sourceTabId,
          discoveryTabId,
          index: index + 1,
          total: rows.length,
          ...result,
        });
      } catch (error) {
        nativeResults.push({
          model,
          label: String(row.label || model),
          selectorKey: String(row.selectorKey || ''),
          pickerMode: 'B',
          discoverySource: 'official-work-picker-b',
          nativeRequestModel: null,
          nativeResponseModel: null,
          nativeRequestConfirmed: false,
          nativeResponseConfirmed: false,
          nativeVerified: false,
          error: errorText(error),
        });
        logRuntime('warn', 'discovery', 'official_work_model_native_failed', {
          sourceTabId,
          discoveryTabId,
          index: index + 1,
          total: rows.length,
          model,
          error: errorText(error),
        });
      } finally {
        verificationTransactions.delete(discoveryTabId);
        progress.activeStage = {
          ...progress.activeStage,
          completed: index + 1,
          verified: nativeResults.filter((item) => item.nativeVerified).length,
          requestConfirmed: nativeResults.filter((item) => item.nativeRequestConfirmed).length,
          currentModel: null,
          currentLabel: index + 1 < rows.length
            ? '准备验证下一个 Picker B（Work）'
            : 'Picker B（Work）验证完成',
        };
        await broadcastVerificationTabs(sourceTabId, ownerTabId, [discoveryTabId]);
      }
    }

    const chatRows = nativeResults
      .filter((item) => item.nativeVerified && item.nativeRequestModel)
      .map((item) => ({
        model: item.model,
        rawId: item.model,
        label: item.label,
        selectorKey: '__picker_b_chat_lock__',
        pickerMode: 'B',
        discoverySource: 'official-work-picker-b',
        transportModel: item.nativeRequestModel,
        expectedResponseModel: item.nativeResponseModel,
        nativeRequestModel: item.nativeRequestModel,
        nativeResponseModel: item.nativeResponseModel,
        nativeResponseConfirmed: item.nativeResponseConfirmed,
        nativeResponseObserved: item.nativeResponseObserved === true,
        nativeVerificationBasis: item.nativeVerificationBasis || null,
      }));

    progress.activeStage = null;
    progress.currentModel = null;
    progress.currentSelectorKey = null;
    progress.currentLabel = null;
    await broadcastVerificationTabs(sourceTabId, ownerTabId, [discoveryTabId]);
    logRuntime(nativeResults.length ? 'info' : 'warn', 'discovery', 'official_work_model_discovery_completed', {
      sourceTabId,
      discoveryTabId,
      entered: enter?.entered === true,
      bootstrapSent,
      pickerMode: 'B',
      models: nativeResults.map((item) => item.model),
      nativeVerified: nativeResults.filter((item) => item.nativeVerified).length,
      candidateCount: nativeResults.length,
    });
    return {
      pickerMode: 'B',
      rows,
      models: nativeResults.map((item) => item.model),
      reasoningLevels: discovered.reasoningLevels || [],
      nativeResults,
      chatCandidates: {
        pickerMode: 'B',
        rows: chatRows,
        models: chatRows.map((item) => item.model),
        reasoningLevels: discovered.reasoningLevels || [],
      },
    };
  } catch (error) {
    logRuntime('warn', 'discovery', 'official_work_model_discovery_unavailable', {
      sourceTabId,
      discoveryTabId,
      reason: errorText(error),
    });
    return { pickerMode: 'B', rows: [], models: [], nativeResults: [], chatCandidates: { pickerMode: 'B', rows: [], models: [], reasoningLevels: [] } };
  } finally {
    if (Number.isInteger(discoveryTabId)) {
      await networkMonitor.disableResponseCapture(discoveryTabId).catch(() => {});
      await networkMonitor.detach(discoveryTabId).catch(() => {});
    }
    if (activatedForReadiness && restoreActiveTabId && restoreActiveTabId !== discoveryTabId) {
      await chrome.tabs.update(restoreActiveTabId, { active: true }).catch(() => null);
    }
    if (Number.isInteger(discoveryTabId)) await chrome.tabs.remove(discoveryTabId).catch(() => null);
    if (Number.isInteger(discoveryTabId)) {
      logRuntime('info', 'discovery', 'official_work_model_discovery_tab_closed', {
        sourceTabId,
        discoveryTabId,
        restoredActiveTabId: activatedForReadiness ? restoreActiveTabId : null,
      });
    }
  }
}

async function publishAccountModels(accountCatalog, progress) {
  const byModel = new Map();
  const ensure = (modelValue, seed = {}) => {
    const model = normalizeConcreteModelId(modelValue);
    if (!model) return null;
    const current = byModel.get(model) || {
      model,
      label: String(seed.label || model).trim().slice(0, 120),
      pickerMode: ['A', 'B'].includes(seed.pickerMode) ? seed.pickerMode : null,
      requestConfirmed: false,
      responseConfirmed: false,
      nativeRequestModel: null,
      nativeResponseModel: null,
      nativeResponseConfirmed: false,
      chatTransportModel: null,
      chatResponseModel: null,
      chatLockRequestConfirmed: false,
      chatLockResponseConfirmed: false,
      chatLockSupported: false,
      discoverySource: seed.discoverySource || null,
    };
    if (!current.pickerMode && ['A', 'B'].includes(seed.pickerMode)) current.pickerMode = seed.pickerMode;
    if (seed.label) current.label = String(seed.label).trim().slice(0, 120);
    if (seed.discoverySource) current.discoverySource = seed.discoverySource;
    byModel.set(model, current);
    return current;
  };

  for (const row of accountCatalog?.rows || []) {
    ensure(row?.model || row?.rawId, {
      label: row?.label || row?.displayName,
      pickerMode: row?.pickerMode,
      discoverySource: row?.discoverySource || 'chat-picker-a',
    });
  }

  for (const item of progress?.officialWorkDiscovery?.nativeResults || []) {
    const current = ensure(item?.model, {
      label: item?.label,
      pickerMode: 'B',
      discoverySource: 'official-work-picker-b',
    });
    if (!current) continue;
    current.nativeRequestModel = normalizeRawProtocolModelId(item?.nativeRequestModel) || current.nativeRequestModel;
    current.nativeResponseModel = normalizeRawProtocolModelId(item?.nativeResponseModel) || current.nativeResponseModel;
    current.nativeResponseConfirmed = current.nativeResponseConfirmed || item?.nativeResponseConfirmed === true;
    current.requestConfirmed = current.requestConfirmed || item?.nativeRequestConfirmed === true;
    current.responseConfirmed = current.responseConfirmed || item?.nativeResponseConfirmed === true;
  }

  for (const item of progress?.results || []) {
    const model = normalizeConcreteModelId(item?.model || item?.requestModel || item?.evidenceModel);
    if (!model) continue;
    const current = ensure(model, {
      label: item?.label,
      pickerMode: item?.pickerMode,
      discoverySource: item?.discoverySource,
    });
    if (!current) continue;

    current.requestConfirmed = current.requestConfirmed || item?.requestConfirmed === true;
    current.responseConfirmed = current.responseConfirmed || item?.responseConfirmed === true;
    current.nativeRequestModel = normalizeRawProtocolModelId(item?.nativeRequestModel)
      || normalizeRawProtocolModelId(item?.rawRequestModel)
      || current.nativeRequestModel;
    current.nativeResponseModel = normalizeRawProtocolModelId(item?.nativeResponseModel)
      || (!item?.chatLockRequestConfirmed ? normalizeRawProtocolModelId(item?.rawResponseModel) : null)
      || current.nativeResponseModel;
    current.nativeResponseConfirmed = current.nativeResponseConfirmed
      || item?.nativeResponseConfirmed === true
      || (item?.pickerMode === 'A' && item?.responseConfirmed === true);

    if (item?.chatLockRequestConfirmed === true || item?.chatLockResponseConfirmed === true || item?.chatLockSupported === true) {
      current.chatLockRequestConfirmed = current.chatLockRequestConfirmed || item?.chatLockRequestConfirmed === true;
      current.chatLockResponseConfirmed = current.chatLockResponseConfirmed || item?.chatLockResponseConfirmed === true;
      current.chatLockSupported = current.chatLockSupported || item?.chatLockSupported === true;
      if (item?.chatLockSupported === true) {
        current.chatTransportModel = normalizeRawProtocolModelId(item?.chatTransportModel)
          || normalizeRawProtocolModelId(item?.rawRequestModel)
          || current.chatTransportModel;
        current.chatResponseModel = normalizeRawProtocolModelId(item?.chatResponseModel)
          || normalizeRawProtocolModelId(item?.rawResponseModel)
          || current.chatResponseModel;
      }
    }
  }

  const models = [...byModel.values()]
    .filter((item) => item.pickerMode || item.nativeResponseConfirmed || item.chatLockSupported)
    .slice(0, 128);
  if (!models.length) return [];

  try {
    const result = await accountClient.publishSharedModels(models);
    const shared = (Array.isArray(result?.models) ? result.models : [])
      .map((item) => ({
        model: normalizeConcreteModelId(item?.model),
        label: String(item?.label || '').trim().slice(0, 120),
        pickerMode: ['A', 'B'].includes(item?.pickerMode) ? item.pickerMode : null,
        nativeRequestModel: normalizeRawProtocolModelId(item?.nativeRequestModel),
        nativeResponseModel: normalizeRawProtocolModelId(item?.nativeResponseModel),
        chatTransportModel: normalizeRawProtocolModelId(item?.chatTransportModel),
        chatResponseModel: normalizeRawProtocolModelId(item?.chatResponseModel),
        chatLockVerifiedCount: Math.max(0, Number(item?.chatLockVerifiedCount || 0)),
        discoveredCount: Math.max(0, Number(item?.discoveredCount || 0)),
        verifiedCount: Math.max(0, Number(item?.verifiedCount || 0)),
        lastSeenAt: item?.lastSeenAt || null,
      }))
      .filter((item) => item.model);
    const generation = Math.max(0, Number(result?.generation || 0));
    sharedKnownModelIds = new Set(shared.map((item) => item.model).filter(Boolean));
    sharedModelProtocolMap = new Map(shared
      .map((item) => ({
        model: item.model,
        transport: item.chatTransportModel || (item.pickerMode === 'A' ? item.nativeRequestModel : null),
      }))
      .filter((item) => item.model && item.transport)
      .map((item) => [item.model, item.transport]));
    rememberProvenPickerBChatModels(shared);
    await Promise.all([
      chrome.storage.sync.set({ [SHARED_KNOWN_MODELS_KEY]: shared }),
      chrome.storage.local.set({
        [SHARED_MODEL_CATALOG_GENERATION_KEY]: generation,
        [SHARED_MODEL_CATALOG_ACCOUNT_KEY]: Number(accountState?.user?.id || 0),
      }),
    ]);
    lastServerModelCatalogGeneration = Math.max(lastServerModelCatalogGeneration ?? 0, generation);
    logRuntime('info', 'discovery', 'shared_model_catalog_published', {
      submitted: models.length,
      nativeResponseConfirmed: models.filter((item) => item.nativeResponseConfirmed).length,
      chatLockSupported: models.filter((item) => item.chatLockSupported).length,
      shared: shared.length,
      generation,
    });
    return shared;
  } catch (error) {
    logRuntime('warn', 'discovery', 'shared_model_catalog_publish_failed', {
      submitted: models.length,
      error: errorText(error),
    });
    return [];
  }
}

async function discoverAccountCatalog(tabId) {
  try {
    const result = await sendTabMessage(tabId, { type: 'GPTLOCK_DISCOVER_ACCOUNT_MODELS' });
    const rows = Array.isArray(result?.catalog?.models) ? result.catalog.models : [];
    const models = [...new Set(rows
      .map((item) => normalizeConcreteModelId(item?.model || item?.rawId))
      .filter(Boolean))];
    const reasoningLevels = [...new Set((Array.isArray(result?.catalog?.reasoningLevels)
      ? result.catalog.reasoningLevels
      : []).map(normalizeReasoningLevel).filter(Boolean))];
    // Account-menu DOM is discovery input, not authoritative persistence. A model is
    // promoted to discoveredModels by model-catalog.js only after the per-model probe
    // produces trusted network request/response metadata.
    const nameMappings = await resolveUnknownCatalogNames(tabId, rows);
    logRuntime(models.length ? 'info' : 'warn', 'discovery', 'account_model_catalog_discovered', {
      tabId,
      models,
      reasoningLevels,
      rowCount: rows.length,
      candidateCount: Number(result?.catalog?.candidateCount || 0),
      triggerFound: result?.catalog?.triggerFound === true,
      pickerKind: result?.catalog?.pickerKind ?? null,
      pickerMode: result?.catalog?.pickerMode ?? null,
      nameMappings,
    });
    const pickerMode = result?.catalog?.pickerMode ?? null;
    return { models, reasoningLevels, rows: rows.map((row) => ({ ...row, pickerMode })), nameMappings, pickerMode };
  } catch (error) {
    logRuntime('warn', 'discovery', 'account_model_catalog_discovery_failed', {
      tabId,
      error: errorText(error),
    });
    return { models: [], reasoningLevels: [], rows: [], error: errorText(error) };
  }
}

async function recoverStaleVerificationTurn(tabId, assistantCountBefore) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    logRuntime('warn', 'discovery', 'verification_stale_generation_reload', { tabId, attempt, maxAttempts: 3 });
    await chrome.tabs.reload(tabId);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const settled = await sendTabMessage(tabId, {
      type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED',
      assistantCountBefore,
      timeoutMs: 3500,
    }).catch(() => null);
    if (settled?.settled === true || settled?.stillGenerating === false) {
      logRuntime('info', 'discovery', 'verification_stale_generation_recovered', { tabId, attempt, method: 'reload' });
      return { settled: true, method: 'reload', attempt };
    }
  }
  const stopped = await sendTabMessage(tabId, { type: 'GPTLOCK_STOP_STALE_GENERATION' }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const settled = await sendTabMessage(tabId, {
    type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED',
    assistantCountBefore,
    timeoutMs: 3500,
  }).catch(() => null);
  const ok = stopped?.stopped === true && (settled?.settled === true || settled?.stillGenerating === false);
  logRuntime(ok ? 'info' : 'warn', 'discovery', 'verification_stale_generation_recovered', {
    tabId, method: 'stop-button', stopped: stopped?.stopped === true, settled: Boolean(ok),
  });
  return { settled: Boolean(ok), method: 'stop-button', stopped: stopped?.stopped === true };
}

let verificationPromptBankCache = null;

async function loadVerificationPromptBank() {
  if (verificationPromptBankCache) return verificationPromptBankCache;
  const response = await fetch(chrome.runtime.getURL('prompt-bank.json'));
  if (!response.ok) throw new Error(`Prompt bank load failed: ${response.status}`);
  const parsed = await response.json();
  const prompts = Array.isArray(parsed) ? parsed : parsed?.prompts;
  if (!Array.isArray(prompts) || prompts.length < 100) throw new Error('Prompt bank must contain at least 100 prompts');
  verificationPromptBankCache = prompts.map((item) => String(item || '').trim()).filter(Boolean);
  return verificationPromptBankCache;
}

async function randomVerificationPrompt() {
  const bank = await loadVerificationPromptBank();
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bank[bytes[0] % bank.length];
}

async function sendVerificationReasoningProbe(tabId, marker, ordinal, total) {
  const prompt = await randomVerificationPrompt();
  return sendTabMessage(tabId, {
    type: 'GPTLOCK_AUTO_SEND_PROBE',
    skipAlignment: true,
    probeMarker: marker,
    probeText: prompt,
  });
}

async function reacquirePickerBForModel(tabId, desiredModel, progress) {
  let catalog = await discoverAccountCatalog(tabId);
  progress.discoveryPasses += 1;
  const hasDesired = () => (catalog?.rows || []).some((row) => normalizeConcreteModelId(row?.model || row?.rawId) === desiredModel);
  if (catalog?.pickerMode === 'B' && hasDesired()) return catalog;
  logRuntime('info', 'discovery', 'picker_b_reacquire_started', { tabId, desiredModel, observedPickerMode: catalog?.pickerMode ?? null });
  const workBootstrap = beginWorkBootstrapTransaction(tabId, 'picker-b-reacquire');
  try {
    const probe = await sendVerificationReasoningProbe(tabId, 'work-mode-b-reacquire', progress.completed + 1, progress.total);
    if (!probe?.sent) return catalog;
    const settled = await sendTabMessage(tabId, { type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED', assistantCountBefore: probe.assistantCountBefore ?? 0, timeoutMs: AUTO_VERIFY_RESPONSE_TIMEOUT_MS });
    if (settled?.settled !== true) return catalog;
  } finally {
    endWorkBootstrapTransaction(tabId, workBootstrap.previous);
  }
  const deadline = Date.now() + 10000;
  do {
    catalog = await discoverAccountCatalog(tabId);
    progress.discoveryPasses += 1;
    if (catalog?.pickerMode === 'B' && hasDesired()) break;
    await sleep(500);
  } while (Date.now() < deadline);
  logRuntime(hasDesired() ? 'info' : 'warn', 'discovery', 'picker_b_reacquire_completed', { tabId, desiredModel, pickerMode: catalog?.pickerMode ?? null, available: hasDesired() });
  return catalog;
}

async function verifyAccountCatalogModels(
  tabId,
  state,
  accountCatalog,
  { restoreModel = null, sharedCandidates = [], localNetworkCandidates = [], ownerTabId = tabId } = {},
) {
  // v0.5.176 model discovery is source-first. Server history and previous local
  // network candidates are diagnostic inputs only; they never seed a discovery run.
  const catalog = createVerificationCatalog({
    normalizeModel: normalizeConcreteModelId,
    onMerged: ({ phase, added, total, reasoningLevels }) => {
      state.autoVerification.maxAttempts = total;
      logRuntime('info', 'discovery', 'model_discovery_catalog_merged', {
        tabId, phase, added, total, reasoningLevels,
      });
    },
  });
  const { queue, knownKeys, progress } = catalog;
  state.autoVerification.catalogVerification = progress;
  const mergeCatalog = catalog.merge;
  progress.officialWorkDiscovery = {
    attempted: false,
    entered: false,
    pickerMode: null,
    nativeResults: [],
    chatCompatibilityCandidates: 0,
  };
  progress.ignoredSeedCandidates = {
    shared: Array.isArray(sharedCandidates) ? sharedCandidates.length : 0,
    localNetwork: Array.isArray(localNetworkCandidates) ? localNetworkCandidates.length : 0,
  };
  progress.ownerTabId = Number.isInteger(ownerTabId) ? ownerTabId : tabId;

  mergeCatalog(accountCatalog, 'chat-picker-a');
  await broadcastVerificationState(tabId, ownerTabId);
  logRuntime(queue.length ? 'info' : 'warn', 'discovery', 'model_discovery_started', {
    tabId,
    chatPickerModels: queue.map((item) => item.model || item.label),
    ignoredSeedCandidates: progress.ignoredSeedCandidates,
  });

  let index = 0;
  let stablePasses = 0;
  let pickerAChatLockQueued = false;
  let officialWorkDiscoveryDone = false;
  const transientRetryCounts = new Map();

  while (index < queue.length || stablePasses < 2 || !officialWorkDiscoveryDone) {
    if (index >= queue.length) {
      if (!pickerAChatLockQueued) {
        pickerAChatLockQueued = true;
        const pickerAChatRows = progress.results
          .filter((item) => (
            item?.pickerMode === 'A'
            && item?.selectorKey !== '__picker_a_chat_lock__'
            && item?.verified === true
            && normalizeRawProtocolModelId(item?.rawRequestModel || item?.nativeRequestModel)
          ))
          .map((item) => ({
            model: normalizeConcreteModelId(item.model),
            rawId: normalizeConcreteModelId(item.model),
            label: item.label || item.model,
            selectorKey: '__picker_a_chat_lock__',
            pickerMode: 'A',
            discoverySource: 'chat-picker-a',
            transportModel: normalizeRawProtocolModelId(item.rawRequestModel || item.nativeRequestModel),
            expectedResponseModel: normalizeRawProtocolModelId(item.rawResponseModel || item.nativeResponseModel),
            nativeRequestModel: normalizeRawProtocolModelId(item.rawRequestModel || item.nativeRequestModel),
            nativeResponseModel: normalizeRawProtocolModelId(item.rawResponseModel || item.nativeResponseModel),
            nativeResponseConfirmed: item.responseConfirmed === true,
          }))
          .filter((item) => item.model && item.transportModel);
        progress.pickerAChatLockCandidates = pickerAChatRows.length;
        const pickerAAdded = mergeCatalog({
          pickerMode: 'A',
          rows: pickerAChatRows,
          models: pickerAChatRows.map((item) => item.model),
          reasoningLevels: [],
        }, 'picker-a-chat-lock');
        logRuntime('info', 'discovery', 'picker_a_chat_lock_queued', {
          tabId,
          candidates: pickerAChatRows.length,
          added: pickerAAdded,
          models: pickerAChatRows.map((item) => item.model),
        });
        if (pickerAAdded) {
          stablePasses = 0;
          await broadcastVerificationState(tabId, ownerTabId);
          continue;
        }
      }

      if (!officialWorkDiscoveryDone) {
        const officialWork = await discoverOfficialWorkModels(tabId, progress);
        officialWorkDiscoveryDone = true;
        progress.officialWorkDiscovery = {
          attempted: true,
          entered: officialWork?.nativeResults?.length > 0 || officialWork?.rows?.length > 0,
          pickerMode: officialWork?.pickerMode ?? null,
          nativeResults: Array.isArray(officialWork?.nativeResults) ? officialWork.nativeResults : [],
          chatCompatibilityCandidates: Number(officialWork?.chatCandidates?.rows?.length || 0),
        };
        const added = mergeCatalog(officialWork?.chatCandidates, 'picker-b-chat-compatibility');
        if (added) stablePasses = 0;
        await broadcastVerificationState(tabId, ownerTabId);
        if (index < queue.length) continue;
      }

      const rediscovered = await discoverAccountCatalog(tabId);
      progress.discoveryPasses += 1;
      const added = mergeCatalog(rediscovered, 'chat-picker-a-settle');
      stablePasses = added ? 0 : stablePasses + 1;
      progress.stablePasses = stablePasses;
      await broadcastVerificationState(tabId, ownerTabId);
      if (index >= queue.length && stablePasses < 2) await sleep(650);
      continue;
    }

    const item = queue[index];
    const pickerAChatLock = item.selectorKey === '__picker_a_chat_lock__';
    const pickerBChatLock = item.selectorKey === '__picker_b_chat_lock__';
    const chatCompatibility = pickerAChatLock || pickerBChatLock;
    const chatLockEventPrefix = pickerAChatLock ? 'picker_a_chat_lock' : 'picker_b_chat_compatibility';
    const pickerNative = !chatCompatibility && ['A', 'B'].includes(item.pickerMode);
    progress.currentModel = item.model;
    progress.currentSelectorKey = item.selectorKey;
    progress.currentLabel = item.label;
    state.autoVerification.attempt = index + 1;
    const transactionStartedAtMs = Date.now();
    verificationTransactions.set(Number(tabId), {
      model: item.model || null,
      selectorKey: item.selectorKey || '',
      label: item.label || '',
      mode: chatCompatibility ? 'force-transport' : 'observe-native',
      transportModel: chatCompatibility ? item.transportModel : null,
      startedAt: transactionStartedAtMs,
    });
    resetVerificationAttempt(state);
    await broadcastVerificationState(tabId, ownerTabId);

    logRuntime('info', 'discovery', chatCompatibility
      ? `${chatLockEventPrefix}_started`
      : 'chat_picker_model_native_started', {
      tabId,
      index: index + 1,
      total: queue.length,
      model: item.model,
      selectorKey: item.selectorKey,
      label: item.label,
      transportModel: item.transportModel || null,
      expectedResponseModel: item.expectedResponseModel || null,
    });

    let abortForPendingTurn = false;
    try {
      const attached = networkMonitor.isAttached(tabId) || await networkMonitor.attach(tabId);
      if (!attached) throw new Error(state.monitor?.error || 'Request monitor is not attached');

      let selection = { selectionAttempted: false, observation: state.pageObservation || null };
      if (pickerNative) {
        const selectionResponse = await sendTabMessage(tabId, {
          type: 'GPTLOCK_VERIFY_ACCOUNT_MODEL',
          model: item.model,
          selectorKey: item.selectorKey,
          label: item.label,
        });
        selection = selectionResponse?.result || {};
        if (selection.selectionAttempted !== true) throw new Error('Chat Picker model selection control was not activated');
        await sleep(700);
      }

      const reattached = await networkMonitor.attach(tabId);
      if (!reattached) throw new Error(state.monitor?.error || 'Request monitor did not reattach');
      if (!await networkMonitor.enableResponseCapture(tabId)) {
        throw new Error('Response capture did not enable before discovery probe');
      }

      const probe = await sendVerificationReasoningProbe(
        tabId,
        pickerAChatLock
          ? 'GPTWork 发现模型 · Picker A Chat lock'
          : pickerBChatLock
            ? 'GPTWork 发现模型 · Picker B Chat compatibility'
            : 'GPTWork 发现模型 · Chat native',
        index + 1,
        queue.length,
      );
      if (!probe?.sent) throw new Error('Model discovery probe was not sent');

      const [networkEvidence, turnSettled] = await Promise.all([
        waitForNetworkModelEvidence(
          tabId,
          transactionStartedAtMs,
          AUTO_VERIFY_RESPONSE_TIMEOUT_MS,
          { allowModelMissing: chatCompatibility },
        ),
        sendTabMessage(tabId, {
          type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED',
          assistantCountBefore: probe.assistantCountBefore ?? 0,
          timeoutMs: AUTO_VERIFY_RESPONSE_TIMEOUT_MS,
        }),
      ]);

      let effectiveTurnSettled = turnSettled;
      if (effectiveTurnSettled?.settled !== true) {
        effectiveTurnSettled = await recoverStaleVerificationTurn(tabId, probe.assistantCountBefore ?? 0);
      }
      if (effectiveTurnSettled?.settled !== true) {
        abortForPendingTurn = true;
        throw new Error('ChatGPT response remained non-terminal during model discovery');
      }

      const requestId = networkEvidence?.requestId
        || state.lastRequest?.requestId
        || state.lastForwardedRequest?.requestId
        || null;
      const responseEvidence = networkEvidence?.evidence
        || (state.lastResponseEvidence?.requestId === requestId ? state.lastResponseEvidence : null);
      const rawRequestModel = normalizeRawProtocolModelId(
        state.lastRewrite?.transportModelAfter
          || state.lastRewrite?.transportModelBefore
          || state.lastRequest?.rawModel
          || state.lastRequest?.model,
      );
      const rawResponseProtocolModel = normalizeRawProtocolModelId(
        responseEvidence?.rawModel
          || state.lastResponseEvidence?.rawModel
          || state.lastResponseEvidence?.model,
      );
      const requestModel = normalizeConcreteModelId(
        state.lastRewrite?.modelAfter
          || state.lastRequest?.model
          || rawRequestModel,
      );
      const responseModel = normalizeConcreteModelId(
        responseEvidence?.model
          || rawResponseProtocolModel,
      );

      let requestConfirmed = false;
      let responseConfirmed = false;
      let verified = false;
      let evidenceSource = null;
      let responseIssue = null;

      if (chatCompatibility) {
        const expectedTransport = normalizeRawProtocolModelId(item.transportModel);
        const expectedResponse = normalizeRawProtocolModelId(item.expectedResponseModel);
        const rewriteCapturedAtMs = Date.parse(state.lastRewrite?.capturedAt || '');
        const authoritativeRewrite = Boolean(
          state.lastRewrite?.authorityKind === 'model-discovery-chat-compat'
          && state.lastRewrite?.authorityModel === item.model
          && Number.isFinite(rewriteCapturedAtMs)
          && rewriteCapturedAtMs >= transactionStartedAtMs - 250
          && !state.lastRewrite?.error
        );
        requestConfirmed = Boolean(
          authoritativeRewrite
          && expectedTransport
          && rawRequestModel === expectedTransport
        );

        const responseObserved = successfulConversationResponseEvidence(responseEvidence);
        const explicitResponseCompatible = !rawResponseProtocolModel
          || (expectedResponse
            ? rawResponseProtocolModel === expectedResponse
            : normalizeConcreteModelId(rawResponseProtocolModel) === item.model);
        responseConfirmed = Boolean(responseObserved && explicitResponseCompatible);
        responseIssue = responseConfirmed
          ? null
          : rawResponseProtocolModel && !explicitResponseCompatible
            ? pickerAChatLock
              ? 'picker_a_chat_lock_response_mismatch'
              : 'chat_mode_response_differs_from_official_work'
            : 'chat_mode_response_not_observed';
        verified = Boolean(requestId && requestConfirmed && responseConfirmed);
        evidenceSource = rawResponseProtocolModel && responseConfirmed
          ? 'network_response_metadata'
          : responseObserved
            ? 'network_response_stream'
            : requestConfirmed
              ? 'fetch_forwarded_request_metadata'
              : null;
      } else {
        requestConfirmed = Boolean(selection.selectionAttempted && rawRequestModel);
        responseConfirmed = Boolean(rawResponseProtocolModel);
        verified = Boolean(
          requestId
          && selection.selectionAttempted
          && requestConfirmed
          && responseConfirmed
        );
        responseIssue = responseConfirmed ? null : 'native_response_model_missing';
        evidenceSource = responseConfirmed
          ? 'network_response_metadata'
          : requestConfirmed
            ? 'network_request_metadata'
            : null;
      }

      const retryKey = catalog.identity(item);
      const retryCount = transientRetryCounts.get(retryKey) || 0;
      const result = {
        model: item.model || requestModel,
        rawModel: item.rawModel || item.model || requestModel,
        selectorKey: item.selectorKey,
        label: item.label,
        pickerMode: item.pickerMode || null,
        discoverySource: item.discoverySource || null,
        verified,
        selected: pickerNative ? selection.selectionAttempted === true : false,
        requestConfirmed,
        responseConfirmed,
        requestId,
        requestModel,
        rawRequestModel,
        responseModel,
        rawResponseModel: rawResponseProtocolModel,
        evidenceModel: responseModel || requestModel || item.model || null,
        responseReasoning: responseEvidence?.reasoning ?? null,
        responseVerdict: responseConfirmed ? 'verified' : 'unverified',
        responseIssue,
        responseHttpStatus: Number(responseEvidence?.diagnostics?.httpStatus || 0),
        responseBodyError: responseEvidence?.bodyError ?? null,
        evidenceSource,
        timedOut: networkEvidence?.timedOut === true,
        turnSettled: true,
        observation: selection.observation || null,
        nativeRequestModel: chatCompatibility
          ? normalizeRawProtocolModelId(item.nativeRequestModel)
          : rawRequestModel,
        nativeResponseModel: chatCompatibility
          ? normalizeRawProtocolModelId(item.nativeResponseModel)
          : rawResponseProtocolModel,
        nativeResponseConfirmed: chatCompatibility
          ? item.nativeResponseConfirmed === true
          : responseConfirmed,
        chatTransportModel: chatCompatibility ? rawRequestModel : null,
        chatResponseModel: chatCompatibility ? rawResponseProtocolModel : null,
        chatLockRequestConfirmed: chatCompatibility ? requestConfirmed : false,
        chatLockResponseConfirmed: chatCompatibility ? responseConfirmed : false,
        chatLockSupported: chatCompatibility ? verified : false,
        chatVerificationBasis: chatCompatibility
          ? (rawResponseProtocolModel ? 'forced_transport+response_model' : 'forced_transport+response_stream')
          : null,
        retryCount,
      };

      if (!chatCompatibility && shouldRetryTransientResponse(result, { maxRetries: 1 })) {
        transientRetryCounts.set(retryKey, retryCount + 1);
        verificationTransactions.delete(Number(tabId));
        await broadcastVerificationState(tabId, ownerTabId);
        await sleep(650);
        continue;
      }

      progress.results.push(result);
      if (requestConfirmed) progress.requestConfirmed += 1;
      if (verified) progress.verified += 1;
      else progress.failed += 1;

      logRuntime(verified ? 'info' : 'warn', 'discovery', chatCompatibility
        ? `${chatLockEventPrefix}_completed`
        : 'chat_picker_model_native_completed', {
        tabId,
        index: index + 1,
        total: queue.length,
        model: result.model,
        pickerMode: result.pickerMode,
        verified,
        requestConfirmed,
        responseConfirmed,
        rawRequestModel,
        rawResponseModel: rawResponseProtocolModel,
        nativeRequestModel: result.nativeRequestModel,
        nativeResponseModel: result.nativeResponseModel,
        chatLockSupported: result.chatLockSupported,
        responseIssue,
        evidenceSource,
      });
    } catch (error) {
      progress.failed += 1;
      progress.results.push({
        model: item.model,
        selectorKey: item.selectorKey,
        label: item.label,
        pickerMode: item.pickerMode || null,
        discoverySource: item.discoverySource || null,
        nativeRequestModel: item.nativeRequestModel || null,
        nativeResponseModel: item.nativeResponseModel || null,
        nativeResponseConfirmed: item.nativeResponseConfirmed === true,
        chatTransportModel: item.transportModel || null,
        verified: false,
        error: errorText(error),
      });
      logRuntime('warn', 'discovery', chatCompatibility
        ? `${chatLockEventPrefix}_failed`
        : 'chat_picker_model_native_failed', {
        tabId,
        index: index + 1,
        total: queue.length,
        model: item.model,
        error: errorText(error),
      });
    }

    verificationTransactions.delete(Number(tabId));
    index += 1;
    progress.completed = index;
    await broadcastVerificationState(tabId, ownerTabId);

    if (abortForPendingTurn) {
      logRuntime('warn', 'discovery', 'model_discovery_aborted_pending_response', {
        tabId, index, total: queue.length,
      });
      break;
    }

    if (!chatCompatibility) {
      const rediscovered = await discoverAccountCatalog(tabId);
      progress.discoveryPasses += 1;
      const added = mergeCatalog(rediscovered, 'chat-picker-a-post-turn');
      stablePasses = added ? 0 : stablePasses + 1;
      progress.stablePasses = stablePasses;
      await broadcastVerificationState(tabId, ownerTabId);
    }
  }

  verificationTransactions.delete(Number(tabId));
  progress.currentModel = null;
  progress.currentSelectorKey = null;
  progress.currentLabel = null;

  if (restoreModel && queue.some((item) => item.model === restoreModel && item.pickerMode === 'A')) {
    try {
      await sendTabMessage(tabId, {
        type: 'GPTLOCK_VERIFY_ACCOUNT_MODEL',
        model: restoreModel,
        label: restoreModel,
      });
    } catch (error) {
      logRuntime('warn', 'discovery', 'model_discovery_restore_failed', {
        tabId,
        model: restoreModel,
        error: errorText(error),
      });
    }
  }

  logRuntime(progress.failed ? 'warn' : 'info', 'discovery', 'model_discovery_completed', {
    tabId,
    total: progress.total,
    uniqueModels: knownKeys.size,
    requestConfirmed: progress.requestConfirmed,
    verified: progress.verified,
    failed: progress.failed,
    discoveryPasses: progress.discoveryPasses,
    stablePasses: progress.stablePasses,
    officialWorkDiscovery: progress.officialWorkDiscovery,
    reasoningLevels: progress.reasoningLevels,
    results: progress.results,
  });
  await broadcastVerificationState(tabId, ownerTabId);
  return progress;
}

function modelVerificationHistoryRecord(tabId, autoVerification) {
  return createModelVerificationHistoryRecord(tabId, autoVerification, {
    reportType: 'gptwork-model-verification-report',
  });
}

async function persistModelVerificationHistory(tabId, autoVerification) {
  const stored = await chrome.storage.local.get([
    MODEL_VERIFICATION_HISTORY_KEY,
    MODEL_VERIFICATION_HISTORY_ENABLED_KEY,
  ]);
  if (stored[MODEL_VERIFICATION_HISTORY_ENABLED_KEY] !== true) return null;
  const record = modelVerificationHistoryRecord(tabId, autoVerification);
  const previous = Array.isArray(stored[MODEL_VERIFICATION_HISTORY_KEY])
    ? stored[MODEL_VERIFICATION_HISTORY_KEY]
    : [];
  const next = [record, ...previous.filter((item) => item?.id !== record.id)]
    .slice(0, MODEL_VERIFICATION_HISTORY_LIMIT);
  await chrome.storage.local.set({ [MODEL_VERIFICATION_HISTORY_KEY]: next });
  return record;
}

async function autoVerify(tabId) {
  if (!masterRuntimeEnabled()) throw new Error('GPTWork is disabled / GPTWork 已关闭');
  const sourceTabId = tabId;
  const sourceTab = await chrome.tabs.get(sourceTabId);
  if (!isChatGptUrl(sourceTab.url ?? '')) throw new Error('Open chatgpt.com first / 请先打开 chatgpt.com');

  const sourceState = ensureTabState(sourceTabId, sourceTab.url);
  sourceState.windowId = Number.isInteger(sourceTab.windowId) ? sourceTab.windowId : null;
  const startedAt = new Date().toISOString();
  const pageContext = /^https:\/\/chatgpt\.com\/c\/[^/?#]+/i.test(sourceTab.url || '') ? 'existing_chat' : 'new_chat';
  const autoVerification = {
    running: true,
    startedAt,
    completedAt: null,
    pageContext,
    sourceTabId,
    executionTabId: null,
    verificationSurface: null,
    infrastructureFailure: false,
    attempt: 0,
    maxAttempts: 0,
    retries: 0,
    outcome: 'running',
    reason: null,
    requestLockConfirmed: false,
    requestModel: null,
    responseModel: null,
    responseReasoning: null,
    evidenceSource: null,
    attempts: [],
    catalogVerification: null,
  };
  sourceState.autoVerification = autoVerification;
  sourceState.lastError = null;
  resetVerificationAttempt(sourceState);
  sourceState.autoVerification = autoVerification;
  logRuntime('info', 'discovery', 'auto_verify_started', { tabId: sourceTabId, pageContext, execution: 'isolated_tab' });
  await broadcastTabState(sourceTabId);

  let session = null;
  let state = null;
  let coreCheck = { connected: false, error: null };
  let monitorAttached = false;
  let responseCaptureEnabled = false;
  let streamCaptureStarted = false;
  let streamCaptureFinalized = false;
  let page = { collected: false, error: null };
  let accountCatalog = { rows: [], models: [], reasoningLevels: [], pickerMode: null, triggerFound: false, candidateCount: 0 };

  const finalizeStreamCapture = async () => {
    if (!streamCaptureStarted || streamCaptureFinalized || !Number.isInteger(autoVerification.executionTabId)) return;
    try {
      await finalizeAutoVerificationStreamCapture(autoVerification.executionTabId, autoVerification.completedAt || new Date().toISOString());
      streamCaptureFinalized = true;
    } catch (error) {
      logRuntime('warn', 'diagnostics', 'auto_verify_stream_capture_finalize_failed', {
        tabId: autoVerification.executionTabId,
        sourceTabId,
        error: errorText(error),
      });
    }
  };

  const finishInfrastructureFailure = async (reason, error = null, details = {}) => {
    autoVerification.running = false;
    autoVerification.completedAt = new Date().toISOString();
    autoVerification.outcome = 'unverified';
    autoVerification.reason = reason;
    autoVerification.infrastructureFailure = true;
    autoVerification.requestLockConfirmed = false;
    autoVerification.infrastructure = {
      reason,
      error: error ? errorText(error) : null,
      ...details,
    };
    sourceState.lastError = error ? errorText(error) : reason;
    if (state) {
      state.autoVerification = autoVerification;
      state.lastError = sourceState.lastError;
    }
    await finalizeStreamCapture();
    try {
      await persistModelVerificationHistory(sourceTabId, autoVerification);
    } catch (historyError) {
      logRuntime('warn', 'discovery', 'model_verification_history_write_failed', {
        tabId: sourceTabId,
        error: errorText(historyError),
      });
    }
    if (state && Number.isInteger(autoVerification.executionTabId)) {
      await broadcastVerificationState(autoVerification.executionTabId, sourceTabId);
    } else {
      await broadcastTabState(sourceTabId);
    }
    logRuntime('warn', 'discovery', 'auto_verify_infrastructure_failed', {
      tabId: sourceTabId,
      executionTabId: autoVerification.executionTabId,
      reason,
      error: error ? errorText(error) : null,
      verificationSurface: autoVerification.verificationSurface,
      coreConnected: coreCheck.connected === true,
      monitorAttached,
      responseCaptureEnabled,
      ...details,
    });
    return {
      ready: false,
      sent: false,
      outcome: 'unverified',
      reason,
      attempts: 0,
      retries: 0,
      requestLockConfirmed: false,
      requestModel: null,
      responseModel: null,
      responseReasoning: null,
      evidenceSource: null,
      catalogTotal: 0,
      catalogRequestConfirmed: 0,
      catalogVerified: 0,
      catalogFailed: 0,
      checks: {
        coreConnected: coreCheck.connected === true,
        coreError: coreCheck.error ?? null,
        monitorAttached,
        responseCaptureEnabled,
        verificationSurface: autoVerification.verificationSurface,
        pageCollected: page.collected,
        pageCollectionError: page.error,
      },
      autoVerification,
      tabState: publicTabState(sourceState),
    };
  };

  try {
    session = await createVerificationExecutionTab(sourceTabId);
    tabId = session.verificationTabId;
    autoVerification.executionTabId = tabId;
    autoVerification.verificationSurface = session.surface || null;

    const executionTab = await chrome.tabs.get(tabId).catch(() => session.verificationTab || null);
    state = ensureTabState(tabId, executionTab?.url || 'https://chatgpt.com/');
    state.windowId = Number.isInteger(executionTab?.windowId) ? executionTab.windowId : sourceState.windowId;
    state.autoVerification = autoVerification;
    resetVerificationAttempt(state);
    state.autoVerification = autoVerification;
    await broadcastVerificationState(tabId, sourceTabId);

    if (session.ready !== true) {
      return await finishInfrastructureFailure('verification_surface_unavailable', null, {
        surface: session.surface || null,
      });
    }

    coreCheck = await refreshNativeCore({ tolerateFailure: true });
    if (coreCheck.connected !== true) {
      return await finishInfrastructureFailure('verification_core_unavailable', coreCheck.error || 'native_core_unavailable');
    }

    monitorAttached = await networkMonitor.attach(tabId);
    responseCaptureEnabled = monitorAttached
      ? await networkMonitor.enableResponseCapture(tabId).catch(() => false)
      : false;
    logRuntime(responseCaptureEnabled ? 'info' : 'warn', 'network', 'verification_response_capture', {
      tabId,
      sourceTabId,
      enabled: responseCaptureEnabled,
      attachedTabs: networkMonitor.attachedCount(),
      responseCaptureTabs: networkMonitor.responseCaptureCount(),
    });
    if (!monitorAttached || !responseCaptureEnabled) {
      return await finishInfrastructureFailure('verification_network_monitor_unavailable', state.monitor?.error || null);
    }

    try {
      await startAutoVerificationStreamCapture(tabId, startedAt);
      streamCaptureStarted = true;
    } catch (error) {
      logRuntime('warn', 'diagnostics', 'auto_verify_stream_capture_start_failed', { tabId, sourceTabId, error: errorText(error) });
    }

    page = await collectPageObservation(tabId, state);
    state.lastError = page.error;
    await broadcastVerificationState(tabId, sourceTabId);

    // Refresh the server catalog only so normal runtime can restore previously
    // proven Chat transport mappings. Discovery itself never uses server history as
    // candidate input: an empty server must be able to rebuild the live account.
    await syncSharedKnownModels();
    autoVerification.sharedKnownModelCount = 0;
    autoVerification.localNetworkCandidateCount = 0;

    accountCatalog = await discoverAccountCatalog(tabId);
    autoVerification.workDiscovery = {
      attempted: false,
      entered: false,
      reason: 'official_work_discovery_pending',
    };
    autoVerification.maxAttempts = accountCatalog.rows.length;
    await broadcastVerificationState(tabId, sourceTabId);

    const catalogVerification = await verifyAccountCatalogModels(
      tabId,
      state,
      accountCatalog,
      {
        restoreModel: null,
        sharedCandidates: [],
        localNetworkCandidates: [],
        ownerTabId: sourceTabId,
      },
    );

    if (catalogVerification.requestConfirmed > 0) {
      await publishAccountModels(accountCatalog, catalogVerification);
    } else {
      logRuntime('warn', 'discovery', 'shared_model_catalog_publish_skipped', {
        tabId,
        sourceTabId,
        reason: 'zero_request_confirmed',
        total: catalogVerification.total,
        verified: catalogVerification.verified,
        failed: catalogVerification.failed,
      });
    }

    autoVerification.attempts = catalogVerification.results.map((item, index) => ({
      attempt: index + 1,
      sent: Boolean(item.requestId),
      requestLockConfirmed: item.requestConfirmed === true,
      requestModel: item.requestModel ?? null,
      responseModel: item.responseModel ?? null,
      responseConfirmed: item.responseConfirmed === true,
      evidenceModel: item.evidenceModel ?? null,
      responseReasoning: item.responseReasoning ?? null,
      responseIssue: item.responseIssue ?? null,
      evidenceSource: item.evidenceSource ?? null,
      verdict: item.responseVerdict ?? null,
      outcome: item.verified ? 'verified' : 'unverified',
      reason: item.verified ? null : item.error || 'model_verification_incomplete',
    }));

    const successful = catalogVerification.results.filter((item) => item.verified);
    const requestConfirmedResults = catalogVerification.results.filter((item) => item.requestConfirmed);
    const lastResult = catalogVerification.results.at(-1) ?? null;
    const lastVerified = successful.at(-1) ?? null;
    const lastRequestConfirmed = requestConfirmedResults.at(-1) ?? null;
    const verificationSummary = summarizeVerificationOutcome(catalogVerification);
    let finalOutcome = verificationSummary.outcome;
    let finalReason = verificationSummary.reason;

    if (catalogVerification.total > 0 && catalogVerification.requestConfirmed === 0) {
      finalOutcome = 'unverified';
      finalReason = 'verification_infrastructure_no_requests_confirmed';
      autoVerification.infrastructureFailure = true;
    } else if (
      catalogVerification?.officialWorkDiscovery?.attempted === true
      && catalogVerification.officialWorkDiscovery.entered !== true
    ) {
      finalOutcome = Number(catalogVerification?.verified || 0) > 0 ? 'partial' : 'unverified';
      finalReason = 'official_work_model_discovery_incomplete';
    }

    autoVerification.running = false;
    autoVerification.completedAt = new Date().toISOString();
    autoVerification.outcome = finalOutcome;
    autoVerification.reason = finalReason;
    autoVerification.retries = 0;
    autoVerification.requestLockConfirmed = catalogVerification.total > 0
      && catalogVerification.requestConfirmed === catalogVerification.total;
    autoVerification.requestModel = lastResult?.requestModel ?? lastRequestConfirmed?.requestModel ?? null;
    autoVerification.responseModel = lastVerified?.responseModel ?? null;
    autoVerification.responseReasoning = lastVerified?.responseReasoning ?? null;
    autoVerification.evidenceSource = lastVerified
      ? 'network_response_metadata'
      : lastRequestConfirmed
        ? 'network_request_metadata'
        : null;

    await finalizeStreamCapture();
    try {
      await persistModelVerificationHistory(sourceTabId, autoVerification);
    } catch (error) {
      logRuntime('warn', 'discovery', 'model_verification_history_write_failed', { tabId: sourceTabId, error: errorText(error) });
    }
    await networkMonitor.disableResponseCapture(tabId);
    await broadcastVerificationState(tabId, sourceTabId);

    logRuntime(finalOutcome === 'verified' ? 'info' : 'warn', 'discovery', 'auto_verify_completed', {
      tabId: sourceTabId,
      executionTabId: tabId,
      outcome: finalOutcome,
      reason: finalReason,
      catalogTotal: catalogVerification.total,
      catalogRequestConfirmed: catalogVerification.requestConfirmed,
      catalogVerified: catalogVerification.verified,
      catalogFailed: catalogVerification.failed,
      sharedPublishSkipped: catalogVerification.requestConfirmed === 0,
      models: catalogVerification.results.map((item) => ({
        model: item.model,
        verified: item.verified,
        requestConfirmed: item.requestConfirmed === true,
        responseConfirmed: item.responseConfirmed === true,
        requestModel: item.requestModel ?? null,
        networkObservedRequestModel: item.networkObservedRequestModel ?? null,
        responseModel: item.responseModel ?? null,
        evidenceModel: item.evidenceModel ?? null,
        evidenceSource: item.evidenceSource ?? null,
      })),
    });

    sourceState.lastError = state.lastError;
    return {
      ready: catalogVerification.total > 0 && catalogVerification.requestConfirmed > 0,
      sent: catalogVerification.results.some((item) => Boolean(item.requestId)),
      outcome: finalOutcome,
      reason: finalReason,
      attempts: catalogVerification.total,
      retries: 0,
      requestLockConfirmed: autoVerification.requestLockConfirmed,
      requestModel: autoVerification.requestModel,
      responseModel: autoVerification.responseModel,
      responseReasoning: autoVerification.responseReasoning,
      evidenceSource: autoVerification.evidenceSource,
      catalogTotal: catalogVerification.total,
      catalogRequestConfirmed: catalogVerification.requestConfirmed,
      catalogVerified: catalogVerification.verified,
      catalogFailed: catalogVerification.failed,
      checks: {
        coreConnected: coreCheck.connected,
        coreError: coreCheck.error,
        monitorAttached,
        responseCaptureEnabled,
        verificationSurface: autoVerification.verificationSurface,
        pageCollected: page.collected,
        pageCollectionError: page.error,
        pageModel: normalizeConcreteModelId(state.pageObservation?.model),
        pageReasoning: state.pageObservation?.reasoning ?? null,
        discoveredModels: accountCatalog.models,
        discoveredReasoningLevels: accountCatalog.reasoningLevels,
      },
      autoVerification,
      tabState: publicTabState(sourceState),
    };
  } catch (error) {
    return await finishInfrastructureFailure('verification_infrastructure_failure', error);
  } finally {
    await finalizeStreamCapture();
    if (session) await closeVerificationExecutionTab(session);
    sourceState.autoVerification = autoVerification;
    await broadcastTabState(sourceTabId);
  }
}

function diagnosticTabState(state) {
  return {
    tabId: state.tabId,
    inScope: isChatGptUrl(state.url),
    contextKey: state.contextKey,
    core: state.core,
    monitor: state.monitor,
    phase: state.phase,
    probeUsed: state.probeUsed,
    probeArmed: state.probeArmed,
    pageObservation: state.pageObservation,
    lastRewrite: state.lastRewrite,
    lastRequest: state.lastRequest ? {
      capturedAt: state.lastRequest.capturedAt,
      model: state.lastRequest.model,
      reasoning: state.lastRequest.reasoning,
      diagnostics: state.lastRequest.diagnostics,
    } : null,
    lastVerification: state.lastVerification,
    lastResponseEvidence: state.lastResponseEvidence,
    lastEvidenceDiagnostics: state.lastEvidenceDiagnostics,
    streamTracking: state.streamTracking,
    evidenceIssue: state.evidenceIssue,
    lastError: state.lastError,
    autoVerification: state.autoVerification,
    updatedAt: state.updatedAt,
    guard: guardFor(state),
  };
}

function diagnosticExportLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 300;
  return Math.min(300, Math.max(1, Math.trunc(parsed)));
}

async function createDiagnosticBundle({ entryLimit = 300 } = {}) {
  const limit = diagnosticExportLimit(entryLimit);
  const [stored, allRuntimeLogs, platform] = await Promise.all([
    chrome.storage.local.get(['nativeStatus', DIAGNOSTIC_SSE_STORAGE_KEY]),
    getRuntimeLogs(),
    getPlatformInfo(),
  ]);
  const runtimeLogs = allRuntimeLogs.slice(-limit);
  let nativeDiagnostics = null;
  let nativeDiagnosticsError = null;
  try {
    nativeDiagnostics = await sendNative('get_diagnostics', { auditLimit: limit });
  } catch (error) {
    nativeDiagnosticsError = errorText(error);
  }
  const rawStreamCapture = stored[DIAGNOSTIC_SSE_STORAGE_KEY] ?? null;
  const safeBundle = sanitizeLogValue({
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    exportSelection: {
      recentEntries: limit,
      runtimeLogCount: runtimeLogs.length,
    },
    extension: {
      id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      platform,
      userAgent: navigator.userAgent,
    },
    policy: currentPolicy,
    settings: currentSettings,
    nativeStatus: stored.nativeStatus ?? { connected: false },
    tabs: [...tabStates.values()].map(diagnosticTabState),
    runtimeLogs,
    nativeDiagnostics,
    nativeDiagnosticsError,
  });
  return {
    ...safeBundle,
    privacy: {
      chatContentIncluded: Boolean(rawStreamCapture?.entries?.length),
      autoVerificationStreamIncluded: Boolean(rawStreamCapture?.entries?.length),
      autoVerificationSseIncluded: Boolean(rawStreamCapture?.entries?.some((entry) => entry.transport === 'sse')),
      autoVerificationWebSocketIncluded: Boolean(rawStreamCapture?.entries?.some((entry) => entry.transport === 'websocket')),
      autoVerificationOnly: true,
      accountCredentialsIncluded: false,
      requestHeadersIncluded: false,
      responseHeadersIncluded: false,
      streamResumeTokensMayBeIncluded: Boolean(rawStreamCapture?.entries?.some((entry) => typeof entry.rawSse === 'string' && entry.rawSse.includes('resume_conversation_token'))),
      noteZhCn: '普通聊天仍不打包请求/响应正文。仅自动验证固定测试消息对应的初始 SSE、handoff 后续 SSE 与已匹配 topic 的服务端 WebSocket 接收帧进入诊断包，合计上限 10 MiB。原始 handoff SSE 可能包含短期 resume token、消息/会话 ID 和服务器元数据；不采集 Cookie、Authorization、请求头、响应头或浏览器账号凭据。',
      noteEn: 'Ordinary chat bodies remain excluded. Only the fixed auto-verification probes may contribute initial SSE, post-handoff SSE, and server-to-client WebSocket frames matched to the handoff topic, with one 10 MiB aggregate cap. Raw handoff SSE can contain short-lived resume tokens, message/conversation IDs, and server metadata; cookies, Authorization, request/response headers, and browser account credentials are not captured.',
    },
    autoVerificationStream: rawStreamCapture,
  };
}

chrome.runtime.onInstalled.addListener(() => void initialize());
chrome.runtime.onStartup.addListener(() => void initialize());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    void masterStorageEnabled().then((enabled) => {
      if (enabled) return initialize();
      return chrome.alarms.clear(RECONNECT_ALARM);
    });
  }
  if (alarm.name === ACCOUNT_REFRESH_ALARM) {
    void masterStorageEnabled().then((enabled) => {
      if (enabled) return refreshAccountHeartbeat();
      return chrome.alarms.clear(ACCOUNT_REFRESH_ALARM);
    });
  }
  if (alarm.name === RUNTIME_LOG_UPLOAD_ALARM) {
    void syncRuntimeLogsToNative().catch(() => {});
  }
});

// Keep native window lifecycle listeners registered at all times, but do not turn a
// Master-OFF state into account heartbeats or debugger sweeps.
chrome.windows.onCreated.addListener(() => {
  if (masterRuntimeEnabled()) void refreshAccountHeartbeat();
});
chrome.windows.onRemoved.addListener(() => {
  if (masterRuntimeEnabled()) void refreshAccountHeartbeat();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && !isChatGptUrl(changeInfo.url)) {
    tabStates.delete(tabId);
    if (networkMonitor.isAttached(tabId)) void networkMonitor.detach(tabId);
    return;
  }
  if (isChatGptUrl(tab.url ?? '') && (changeInfo.url || changeInfo.status === 'complete')) {
    void configureTab(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  if (networkMonitor.isAttached(tabId)) void networkMonitor.detach(tabId);
});

function applyConfigurationChange({ policyChanged = false, settingsChanged = false, localEnabledChanged = false } = {}) {
  if (policyChanged && masterRuntimeEnabled()) {
    void syncPolicy().catch(async (error) => {
      await writeNativeStatus({ connected: false, lastError: errorText(error) });
    });
  }
  if (!policyChanged && !settingsChanged && !localEnabledChanged) return;
  logRuntime('info', 'settings', 'configuration_changed', {
    policyChanged,
    settingsChanged,
    localEnabledChanged,
    enabled: currentSettings.enabled,
    responseVerificationEnabled: currentSettings.networkVerificationEnabled,
    strictMode: currentPolicy.strictMode,
  });
  for (const state of tabStates.values()) {
    state.phase = 'initial';
    state.probeUsed = false;
    state.probeArmed = false;
    state.lastRewrite = null;
    state.lastVerification = null;
    state.lastEvidenceDiagnostics = null;
    state.streamTracking = null;
    state.evidenceIssue = null;
    state.lastError = null;
    state.autoVerification = null;
    if (masterRuntimeEnabled()) void broadcastTabState(state.tabId);
  }
  if (localEnabledChanged) {
    if (masterRuntimeEnabled()) void initializeAfterCurrentTask();
    else void stopBackgroundRuntime('master_disabled');
    return;
  }
  void configureOpenTabs();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[LOCAL_ENABLED_KEY]) {
    const next = typeof changes[LOCAL_ENABLED_KEY].newValue === 'boolean'
      ? changes[LOCAL_ENABLED_KEY].newValue
      : currentSettings.enabled;
    const changed = Boolean(currentSettings.enabled) !== next;
    localEnabledOverride = next;
    currentSettings = normalizeSettings({ ...currentSettings, enabled: next });
    if (changed) applyConfigurationChange({ localEnabledChanged: true });
    return;
  }
  if (areaName !== 'sync') return;
  const policyChanged = Boolean(changes.policy);
  const settingsChanged = Boolean(changes.settings);
  if (policyChanged) currentPolicy = normalizePolicy(changes.policy.newValue);
  if (settingsChanged) {
    const syncedSettings = normalizeSettings(changes.settings.newValue);
    currentSettings = normalizeSettings({
      ...syncedSettings,
      enabled: typeof localEnabledOverride === 'boolean' ? localEnabledOverride : syncedSettings.enabled,
    });
  }
  applyConfigurationChange({ policyChanged, settingsChanged });
});

const TAB_FEATURE_MESSAGE_TYPES = new Set([
  'GPTWORK_TAB_FEATURE_GET',
  'GPTWORK_TAB_FEATURE_SET',
  'GPTWORK_MASTER_STATUS',
  'GPTWORK_MASTER_SET',
]);

// These messages are owned by background-update.js. The generic router must return
// false so exactly one listener responds; otherwise Settings can receive the generic
// "Unsupported extension message" error before the updater listener answers.
const UPDATE_MESSAGE_TYPES = new Set([
  'GPTWORK_UPDATE_STATUS_GET',
  'GPTWORK_UPDATE_CHECK',
  'GPTWORK_UPDATE_INSTALL',
  'GPTWORK_CORE_REPAIR',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GPTWORK_SET_JANK_ISOLATION') {
    void applyJankIsolationMode(message.mode, {
      source: message.source || 'message',
      label: message.label || null,
      captureId: message.captureId || null,
    }).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: errorText(error) }),
    );
    return true;
  }
  if (message?.type === 'GPTWORK_GET_JANK_ISOLATION') {
    void chrome.storage.local.get(JANK_ISOLATION_KEY).then((stored) => {
      sendResponse({ ok: true, result: stored[JANK_ISOLATION_KEY] || { mode: 'normal' } });
    });
    return true;
  }
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;
  if (TAB_FEATURE_MESSAGE_TYPES.has(message.type) || UPDATE_MESSAGE_TYPES.has(message.type)) return false;

  const run = async () => {
    switch (message.type) {
      case 'GPTLOCK_GET_STATE': {
        const tabId = Number.isInteger(message.tabId)
          ? message.tabId
          : sender.tab?.id ?? await activeTabId();
        const { nativeStatus } = await chrome.storage.local.get('nativeStatus');
        const state = tabId === null ? null : tabStates.get(tabId);
        if (masterRuntimeEnabled() && tabId !== null && state && isChatGptUrl(state.url)) {
          await collectPageObservation(tabId, state);
        }
        return {
          policy: state ? runtimePolicyForTabSync(state.tabId) : currentPolicy,
          settings: state ? effectiveSettingsForState(state) : currentSettings,
          nativeStatus: nativeStatus ?? { connected: false },
          tabState: state ? publicTabState(state) : null,
          extensionVersion: chrome.runtime.getManifest().version,
          account: accountState,
          accountWindowAllowed: state ? accountAllowsState(state) : false,
        };
      }
      case 'GPTLOCK_ACCOUNT_CONFIG':
        return accountClient.config();
      case 'GPTLOCK_ACCOUNT_REGISTER':
        return accountClient.register(message.email, message.password);
      case 'GPTLOCK_ACCOUNT_RESEND_VERIFICATION':
        return accountClient.resendVerification(message.email);
      case 'GPTLOCK_ACCOUNT_VERIFY_EMAIL':
        return accountClient.verifyEmail(message.email, message.code);
      case 'GPTLOCK_ACCOUNT_LOGIN': {
        accountState = await accountClient.login(message.email, message.password, message.replaceDeviceRecordIds);
        await refreshAccountHeartbeat();
        const models = await syncSharedKnownModels({ force: true });
        await chrome.storage.local.set({
          [SHARED_MODEL_CATALOG_SYNC_VERSION_KEY]: chrome.runtime.getManifest().version,
        });
        logRuntime('info', 'discovery', 'shared_model_catalog_login_sync_completed', {
          accountId: Number(accountState?.user?.id || 0),
          count: models.length,
        });
        return accountState;
      }
      case 'GPTLOCK_ACCOUNT_FORGOT_PASSWORD':
        return accountClient.requestPasswordReset(message.email);
      case 'GPTLOCK_ACCOUNT_RESET_PASSWORD': {
        const result = await accountClient.resetPassword(message.email, message.code, message.newPassword);
        accountState = accountClient.snapshot();
        await configureOpenTabs();
        return result;
      }
      case 'GPTLOCK_ACCOUNT_LOGOUT': {
        accountState = await accountClient.logout();
        serverFeatureSettingsReady = false;
        await configureOpenTabs();
        return accountState;
      }
      case 'GPTLOCK_ACCOUNT_REFRESH':
        return refreshAccountHeartbeat();
      case 'GPTLOCK_ACCOUNT_SECURITY':
        return accountClient.security();
      case 'GPTLOCK_ACCOUNT_RELEASE_DEVICE': {
        const result = await accountClient.releaseDevice(message.deviceRecordId);
        await refreshAccountHeartbeat();
        return result;
      }
      case 'GPTLOCK_ACCOUNT_REVOKE_SESSION': {
        const result = await accountClient.revokeSession(message.sessionId);
        await refreshAccountHeartbeat();
        return result;
      }
      case 'GPTLOCK_ACCOUNT_REVOKE_OTHER_SESSIONS': {
        const result = await accountClient.revokeOtherSessions();
        await refreshAccountHeartbeat();
        return result;
      }
      case 'GPTLOCK_ACCOUNT_CHANGE_PASSWORD':
        return accountClient.changePassword(message.currentPassword, message.newPassword);
      case 'GPTLOCK_ACCOUNT_CREATE_ORDER':
        return accountClient.createOrder(message.planCode, message.paymentMethod);
      case 'GPTLOCK_ACCOUNT_GET_ORDER':
        return accountClient.getOrder(message.orderId);
      case 'GPTLOCK_RECONNECT': {
        if (!await masterStorageEnabled()) return { skipped: true, reason: 'master_disabled' };
        const previousPort = nativePort;
        nativePort = null;
        rejectPending(new Error('Native host reconnect requested'));
        previousPort?.disconnect();
        await initializeAfterCurrentTask();
        logRuntime('info', 'native', 'manual_reconnect_completed');
        return { ok: true };
      }
      case 'GPTLOCK_POINTER_TRACE': {
        if (!sender.tab?.id) throw new Error('Pointer trace requires a tab');
        logRuntime('info', 'ui-pointer', String(message.event || 'trace').slice(0, 80), {
          tabId: sender.tab.id,
          url: sender.tab.url || null,
          ...(message.details && typeof message.details === 'object' ? message.details : {}),
        });
        return { recorded: true };
      }
      case 'GPTLOCK_TRUSTED_POINTER_PREPARE': {
        if (!sender.tab?.id) throw new Error('Trusted pointer preparation requires a tab');
        const attached = networkMonitor.isAttached(sender.tab.id) || await networkMonitor.attach(sender.tab.id);
        if (!attached) throw new Error('Debugger is not attached for trusted pointer input');
        return { attached: true };
      }
      case 'GPTLOCK_TRUSTED_KEY': {
        if (!sender.tab?.id) throw new Error('Trusted keyboard input requires a tab');
        const key = String(message.key || '');
        if (key !== 'Enter') throw new Error('Unsupported trusted key');
        logRuntime('info', 'ui-keyboard', 'cdp_dispatch', {
          tabId: sender.tab.id,
          source: String(message.source || 'unspecified').slice(0, 100),
          key,
          target: message.target ?? null,
        });
        await networkMonitor.trustedKey(sender.tab.id, key);
        return { key };
      }
      case 'GPTLOCK_TRUSTED_POINTER': {
        if (!sender.tab?.id) throw new Error('Trusted pointer input requires a tab');
        const x = Number(message.x);
        const y = Number(message.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) {
          throw new Error('Trusted pointer coordinates are invalid');
        }
        const action = message.action === 'move' ? 'move' : 'click';
        logRuntime('info', 'ui-pointer', 'cdp_dispatch', {
          tabId: sender.tab.id,
          traceId: message.traceId ?? null,
          source: String(message.source || 'unspecified').slice(0, 100),
          action, x, y,
          target: message.target ?? null,
          hit: message.hit ?? null,
        });
        await networkMonitor.trustedPointer(sender.tab.id, { action, x, y });
        return { action, x, y };
      }
      case 'GPTLOCK_PAGE_OBSERVATION': {
        if (!sender.tab?.id) throw new Error('Page observation requires a tab');
        const state = ensureTabState(sender.tab.id, sender.tab.url);
        const previous = state.pageObservation;
        state.pageObservation = {
          model: message.observation?.model ?? null,
          reasoning: message.observation?.reasoning ?? null,
          capturedAt: message.observation?.capturedAt ?? new Date().toISOString(),
          evidenceSource: 'page_dom',
          modelEvidenceSource: message.observation?.modelEvidenceSource ?? 'none',
          reasoningEvidenceSource: message.observation?.reasoningEvidenceSource ?? 'none',
          modelLabel: message.observation?.modelLabel ?? '',
          reasoningLabel: message.observation?.reasoningLabel ?? '',
          ambiguousModel: Boolean(message.observation?.ambiguousModel),
          candidates: Array.isArray(message.observation?.candidates) ? message.observation.candidates.slice(0, 8) : [],
        };
        if (
          previous?.model && state.pageObservation.model
          && previous.model !== state.pageObservation.model
        ) {
          state.phase = 'initial';
          state.lastVerification = null;
          state.lastEvidenceDiagnostics = null;
          state.streamTracking = null;
          state.evidenceIssue = null;
          logRuntime('info', 'page', 'selection_changed', {
            tabId: sender.tab.id,
            previousModel: previous.model,
            previousReasoning: previous.reasoning,
            model: state.pageObservation.model,
            reasoning: state.pageObservation.reasoning,
          });
        }
        await broadcastTabState(sender.tab.id);
        return publicTabState(state);
      }
      case 'GPTLOCK_CONTEXT_BUDGET_DIAGNOSTIC': {
        if (!sender.tab?.id) throw new Error('Context budget diagnostic requires a tab');
        const details = message.details && typeof message.details === 'object' ? message.details : {};
        const numberOrZero = (value) => {
          const number = Number(value);
          return Number.isFinite(number) && number > 0 ? number : 0;
        };
        logRuntime('info', 'context-budget', 'remaining_snapshot', {
          tabId: sender.tab.id,
          conversationHash: String(details.conversationHash || 'ctx-unknown').slice(0, 32),
          model: String(details.model || '').slice(0, 128) || null,
          remainingPercent: Math.min(100, Math.max(0, Number(details.remainingPercent) || 0)),
          remainingDisplay: String(details.remainingDisplay || '').slice(0, 16),
          remainingSource: String(details.remainingSource || 'unknown').slice(0, 80),
          measurementSource: String(details.measurementSource || 'unknown').slice(0, 80),
          historyTokens: numberOrZero(details.historyTokens),
          historyCharacters: numberOrZero(details.historyCharacters),
          historyMessages: numberOrZero(details.historyMessages),
          cumulativeTokens: numberOrZero(details.cumulativeTokens),
          cumulativeCharacters: numberOrZero(details.cumulativeCharacters),
          cumulativeMessages: numberOrZero(details.cumulativeMessages),
          checkpointMatched: details.checkpointMatched === true,
          checkpointRestored: details.checkpointRestored === true,
          hardLimitObservedCount: Math.max(0, Math.floor(Number(details.hardLimitObservedCount) || 0)),
        });
        return { recorded: true };
      }
      case 'GPTLOCK_PERFORMANCE_DIAGNOSTIC': {
        if (!sender.tab?.id) throw new Error('Performance diagnostic requires a tab');
        const details = message.details && typeof message.details === 'object' ? message.details : {};
        logRuntime(details.abnormal === true ? 'warn' : 'info', 'performance', 'page_responsiveness_sample', {
          tabId: sender.tab.id,
          url: sender.tab.url || null,
          eventLoopLagMs: Math.max(0, Math.min(60000, Number(details.eventLoopLagMs) || 0)),
          maxLongTaskMs: Math.max(0, Math.min(60000, Number(details.maxLongTaskMs) || 0)),
          pageLongTaskObserved: details.pageLongTaskObserved === true,
          longTaskCount: Math.max(0, Math.min(10000, Number(details.longTaskCount) || 0)),
          recentLongTasks: sanitizeLogValue(Array.isArray(details.recentLongTasks) ? details.recentLongTasks.slice(-8) : []),
          mutationCount: Math.max(0, Math.min(1000000, Number(details.mutationCount) || 0)),
          mutationCallbacks: Math.max(0, Math.min(100000, Number(details.mutationCallbacks) || 0)),
          maxMutationCallbackMs: Math.max(0, Math.min(60000, Number(details.maxMutationCallbackMs) || 0)),
          verificationRunning: details.verificationRunning === true,
          documentVisibility: String(details.documentVisibility || '').slice(0, 32),
          abnormal: details.abnormal === true,
          runtimeLifecycle: sanitizeLogValue(details.runtimeLifecycle || null),
          cdp: networkMonitor.diagnosticsSnapshot({ reset: true }),
          debuggerAttachedTabs: networkMonitor.attachedCount(),
          responseCaptureTabs: networkMonitor.responseCaptureCount(),
        });
        return { recorded: true };
      }
      case 'GPTLOCK_CONTEXT_CHANGED': {
        if (!sender.tab?.id) throw new Error('Context update requires a tab');
        const state = ensureTabState(sender.tab.id, message.url || sender.tab.url);
        await broadcastTabState(sender.tab.id);
        return publicTabState(state);
      }
      case 'GPTLOCK_SEND_STARTED': {
        if (!sender.tab?.id) throw new Error('Send event requires a tab');
        const state = ensureTabState(sender.tab.id, sender.tab.url);
        const verification = verificationTransactionForTab(sender.tab.id);

        // The request policy must be computed from a fresh page observation. Conversation
        // navigation can replace tab state and leave pageObservation empty even though the
        // floating indicator has already rediscovered the visible model.
        const page = await collectPageObservation(sender.tab.id, state);
        if (!page.collected) {
          logRuntime('warn', 'page', 'pre_send_page_observation_unavailable', {
            tabId: sender.tab.id,
            error: page.error,
          });
        }

        // Normal user turns need Network lifecycle events as well as Fetch interception.
        // v0.5.169 exposed the gap here: Fetch stayed attached after auto verification,
        // but responseCaptureTabs returned to zero, so ordinary turns had no served-model evidence.
        // Auto verification deliberately tears response capture down when it finishes;
        // re-enable it just-in-time before every user send so request/response metadata can
        // be correlated and the served response model is surfaced in the UI.
        if (currentSettings.networkVerificationEnabled) {
          const captureReady = await networkMonitor.enableResponseCapture(sender.tab.id).catch(() => false);
          logRuntime(captureReady ? 'info' : 'warn', 'network', 'normal_response_capture_armed', {
            tabId: sender.tab.id,
            enabled: captureReady,
            responseCaptureTabs: networkMonitor.responseCaptureCount(),
          });
        }

        const guard = guardFor(state);
        if (!verification && !guard.canSend) {
          logRuntime('warn', 'guard', 'send_rejected', {
            tabId: sender.tab.id,
            status: guard.status,
            reason: guard.reason,
          });
          return { accepted: false, guard };
        }
        if (guard.allowKind === 'disabled' || guard.allowKind === 'outside_scope') {
          return { accepted: true, guard };
        }
        if (currentSettings.networkVerificationEnabled) state.phase = 'waiting';
        state.probeUsed = true;
        state.probeArmed = false;
        state.lastError = null;
        state.evidenceIssue = null;
        logRuntime('info', 'guard', 'send_accepted', {
          tabId: sender.tab.id,
          allowKind: guard.allowKind,
          status: guard.status,
        });
        await broadcastTabState(sender.tab.id);
        return { accepted: true, guard: guardFor(state) };
      }
      case 'GPTLOCK_ARM_PROBE': {
        const tabId = Number.isInteger(message.tabId) ? message.tabId : await activeTabId();
        if (tabId === null) throw new Error('No active tab');
        const state = ensureTabState(tabId);
        state.phase = 'initial';
        state.probeArmed = false;
        state.lastVerification = null;
        state.streamTracking = null;
        state.lastError = null;
        state.evidenceIssue = null;
        state.autoVerification = null;
        logRuntime('info', 'discovery', 'legacy_probe_reset', { tabId });
        await broadcastTabState(tabId);
        return publicTabState(state);
      }
      case 'GPTLOCK_AUTO_VERIFY': {
        const tabId = await chatGptTabId(Number.isInteger(message.tabId) ? message.tabId : null);
        if (tabId === null) throw new Error('No ChatGPT tab / 没有打开的 ChatGPT 标签页');
        const state = tabStates.get(tabId);
        if (!state || !accountAllowsState(state)) throw new Error('当前账号没有有效权益');
        const existingTask = autoVerificationTasks.get(tabId);
        if (existingTask) {
          logRuntime('info', 'discovery', 'auto_verify_duplicate_joined', {
            tabId,
            running: Boolean(state.autoVerification?.running),
          });
          return existingTask;
        }
        const task = autoVerify(tabId);
        autoVerificationTasks.set(tabId, task);
        try {
          return await task;
        } finally {
          if (autoVerificationTasks.get(tabId) === task) autoVerificationTasks.delete(tabId);
        }
      }
      case 'GPTLOCK_SEND_BLOCKED': {
        logRuntime('warn', 'guard', 'send_blocked_in_page', {
          tabId: sender.tab?.id ?? null,
          status: message.status ?? null,
          reason: message.reason ?? null,
        });
        return { recorded: true };
      }
      case 'GPTLOCK_VERIFY': {
        const policy = sender.tab?.id
          ? runtimePolicyForTabSync(sender.tab.id)
          : currentPolicy;
        return verifyObservation(message.observation ?? {}, policy);
      }
      case 'GPTLOCK_GET_RUNTIME_LOGS':
        return { logs: await getRuntimeLogs() };
      case 'GPTLOCK_CLEAR_RUNTIME_LOGS':
        await Promise.all([clearRuntimeLogs(), clearAutoVerificationStreamCapture()]);
        logRuntime('info', 'diagnostics', 'runtime_logs_cleared');
        return { cleared: true };
      case 'GPTLOCK_EXPORT_DIAGNOSTICS': {
        const bundle = await createDiagnosticBundle({ entryLimit: message.entryLimit });
        logRuntime('info', 'diagnostics', 'bundle_created', {
          runtimeLogCount: bundle.runtimeLogs?.length ?? 0,
          nativeAuditCount: bundle.nativeDiagnostics?.auditRecords?.length ?? 0,
          nativeDiagnosticsError: bundle.nativeDiagnosticsError,
          rawStreamEntryCount: bundle.autoVerificationStream?.entries?.length ?? 0,
          rawStreamIncludedBytes: bundle.autoVerificationStream?.includedBytes ?? 0,
          rawStreamOverflowed: Boolean(bundle.autoVerificationStream?.overflowed),
        });
        return bundle;
      }
      case 'GPTLOCK_OPEN_DIAGNOSTICS':
        await chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
        return { ok: true };
      case 'GPTLOCK_OPEN_OPTIONS':
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      default:
        throw new Error(`Unsupported extension message: ${message.type}`);
    }
  };

  run().then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || null,
      status: error?.status || null,
      details: error?.details && typeof error.details === 'object' ? error.details : null,
    }),
  );
  return true;
});

void initialize();
