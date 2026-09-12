import {
  DEFAULT_POLICY,
  DEFAULT_SETTINGS,
  normalizePolicy,
  normalizeSettings,
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
  sanitizeLogValue,
} from './runtime-log.js';
import { createAccountClient } from './account-client.js';
import {
  effectivePolicyForTabSync,
  lockConfigurationForTabSync,
  tabFeatureEnabledSync,
} from './tab-feature-runtime.js';
import { ACCOUNT_REFRESH_ALARM } from './account-refresh-scheduler.js';

const NATIVE_HOST = 'com.gptlock.core';
const RECONNECT_ALARM = 'gptlock-native-reconnect';
const REQUEST_TIMEOUT_MS = 7000;
const AUTO_VERIFY_MAX_ATTEMPTS = 2;
const AUTO_VERIFY_RESPONSE_TIMEOUT_MS = 45000;
const AUTO_VERIFY_POLL_MS = 200;
const AUTO_VERIFY_HANDOFF_MIN_WAIT_MS = 9000;
const AUTO_VERIFY_HANDOFF_IDLE_MS = 1200;
const DIAGNOSTIC_SSE_STORAGE_KEY = 'autoVerificationSseCapture';
const LOCAL_ENABLED_KEY = 'gptworkEnabledLocal';

let nativePort = null;
let requestSequence = 0;
let currentPolicy = DEFAULT_POLICY;
let currentSettings = DEFAULT_SETTINGS;
let localEnabledOverride = null;
let coreConnection = { connected: false, error: null };
const pendingRequests = new Map();
const tabStates = new Map();
const accountClient = createAccountClient();
let accountState = { authenticated: false, authorized: false, allowedWindowKeys: [], deniedWindowKeys: [] };

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function logRuntime(level, component, event, details = {}) {
  void appendRuntimeLog(level, component, event, details).catch(() => {});
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
        || (state.autoVerification && !state.contextKey.startsWith('conversation:') && nextContextKey.startsWith('conversation:')),
    );
    if (preserveVerificationState) {
      const previousContextKey = state.contextKey;
      state.url = url;
      state.contextKey = nextContextKey;
      logRuntime('info', 'verification', 'auto_verify_context_migrated', {
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
  return {
    ...currentSettings,
    enabled: Boolean(
      currentSettings.enabled
        && accountAllowsState(state)
        && tabFeatureEnabledSync(state?.tabId),
    ),
  };
}
function guardFor(state) {
  return evaluateGuard({
    state,
    policy: effectivePolicyForTabSync(state?.tabId),
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
    lastEvidenceDiagnostics: state.lastEvidenceDiagnostics,
    streamTracking: state.streamTracking,
    evidenceIssue: state.evidenceIssue,
    lastError: state.lastError,
    autoVerification: state.autoVerification,
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
  state.updatedAt = new Date().toISOString();
  await updateTabBadge(state);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'GPTLOCK_GUARD_STATE',
      state: publicTabState(state),
      policy: effectivePolicyForTabSync(tabId),
      settings: effectiveSettingsForState(state),
    });
  } catch {
    // A content script may not exist yet while a tab is loading.
  }
}

async function ensureConfiguration() {
  const [stored, localStored] = await Promise.all([
    chrome.storage.sync.get(['policy', 'settings']),
    chrome.storage.local.get(LOCAL_ENABLED_KEY),
  ]);
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

function scheduleReconnect() {
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
}

function rejectPending(error) {
  for (const { reject, timer, type } of pendingRequests.values()) {
    clearTimeout(timer);
    reject(error);
    logRuntime('warn', 'native', 'request_rejected', { type, error: errorText(error) });
  }
  pendingRequests.clear();
}

function connectNative() {
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
      void writeNativeStatus({ connected: false, lastError: detail });
      scheduleReconnect();
      logRuntime('warn', 'native', 'disconnected', { error: detail });
    });
    void writeNativeStatus({ connected: true, lastError: null, lastSeenAt: new Date().toISOString() });
    return port;
  } catch (error) {
    const detail = errorText(error);
    void writeNativeStatus({ connected: false, lastError: detail });
    scheduleReconnect();
    logRuntime('error', 'native', 'connect_failed', { error: detail });
    throw error;
  }
}

function sendNative(type, payload = {}) {
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

async function syncPolicy() {
  const result = await sendNative('set_policy', { policy: currentPolicy });
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
    policy,
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
  state.lastEvidenceDiagnostics = evidence.diagnostics ?? null;
  try {
    const result = await verifyObservation({
      model: evidence.conflicts?.model ? null : evidence.model,
      reasoning: evidence.conflicts?.reasoning ? null : evidence.reasoning,
      evidenceSource: 'network_response_metadata',
      capturedAt: evidence.capturedAt,
      requestId: `cdp-${tabId}-${evidence.requestId}`,
    }, effectivePolicyForTabSync(tabId));
    state.lastVerification = result;
    state.evidenceIssue = diagnoseEvidenceIssue(evidence, result);
    state.lastError = evidence.bodyError || (evidence.conflicts?.model || evidence.conflicts?.reasoning
      ? 'conflicting_response_metadata'
      : null);
    state.phase = result.verdict;
    logRuntime(result.verdict === 'verified' ? 'info' : 'warn', 'verification', 'response_evaluated', {
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
      diagnostics: evidence.diagnostics ?? null,
    });
  } catch (error) {
    state.phase = 'error';
    state.evidenceIssue = 'verification_request_failed';
    state.lastError = errorText(error);
    logRuntime('error', 'verification', 'response_evaluation_failed', {
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
    return lockConfigurationForTabSync(tabId, {
      preferredReasoning: currentSettings.preferredReasoning,
      responseVerificationEnabled: currentSettings.networkVerificationEnabled,
    });
  },
  onStatus(tabId, monitor) {
    const state = ensureTabState(tabId);
    state.monitor = monitor;
    if (!monitor.attached && state.phase === 'waiting') {
      state.phase = 'error';
      state.lastError = monitor.error || 'request_lock_monitor_detached';
    }
    logRuntime(monitor.attached ? 'info' : 'warn', 'network', 'monitor_status', {
      tabId,
      attached: monitor.attached,
      error: monitor.error,
    });
    void broadcastTabState(tabId);
  },
  onRewrite(tabId, rewrite) {
    const state = ensureTabState(tabId);
    state.lastRewrite = {
      capturedAt: new Date().toISOString(),
      endpoint: rewrite.endpoint ?? null,
      requestId: rewrite.requestId ?? null,
      changed: Boolean(rewrite.changed),
      reason: rewrite.reason ?? null,
      modelBefore: rewrite.modelBefore ?? null,
      modelAfter: rewrite.modelAfter ?? null,
      transportModelBefore: rewrite.transportModelBefore ?? null,
      transportModelAfter: rewrite.transportModelAfter ?? null,
      reasoningBefore: rewrite.reasoningBefore ?? null,
      reasoningAfter: rewrite.reasoningAfter ?? null,
      reasoningFields: rewrite.reasoningFields ?? [],
      error: rewrite.error ?? null,
    };
    if (rewrite.error) state.lastError = rewrite.error;
    logRuntime(rewrite.error ? 'warn' : 'info', 'lock', rewrite.changed ? 'request_lock_rewritten' : 'request_lock_checked', {
      tabId,
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
    if (failure.downstream) return;
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
  const enabled = effectiveSettingsForState(state).enabled;
  if (!enabled || tab.status === 'loading') await networkMonitor.detach(tab.id);
  else await networkMonitor.attach(tab.id);
  await broadcastTabState(tab.id);
  return state;
}

async function configureOpenTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  await Promise.all(tabs.map((tab) => configureTab(tab)));
}

async function refreshAccountHeartbeat({ reconfigure = true } = {}) {
  if (!accountClient.hasSession()) {
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
  } catch (error) {
    accountState = { ...accountClient.snapshot(), lastError: errorText(error) };
  }
  if (reconfigure) await configureOpenTabs();
  return accountState;
}

async function refreshNativeCore({ tolerateFailure = false } = {}) {
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

async function initialize() {
  logRuntime('info', 'extension', 'initialize_started', {
    version: chrome.runtime.getManifest().version,
  });
  accountState = await accountClient.initialize();
  await ensureConfiguration();
  await refreshNativeCore({ tolerateFailure: true });
  await refreshAccountHeartbeat({ reconfigure: false });
  await configureOpenTabs();
  chrome.alarms.create(ACCOUNT_REFRESH_ALARM, { periodInMinutes: 1 });
  logRuntime('info', 'extension', 'initialize_completed', {
    enabled: currentSettings.enabled,
    responseVerificationEnabled: currentSettings.networkVerificationEnabled,
    coreConnected: coreConnection.connected,
  });
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
  state.lastVerification = null;
  state.lastEvidenceDiagnostics = null;
  state.streamTracking = null;
  state.evidenceIssue = null;
  state.lastError = null;
}

function requestLockConfirmed(state) {
  const policy = effectivePolicyForTabSync(state?.tabId);
  return Boolean(
    state.lastRequest?.model
      && policy.lockedModels.includes(state.lastRequest.model),
  );
}

function verificationOutcome(state, { timedOut = false } = {}) {
  const verification = state.lastVerification;
  const reasons = Array.isArray(verification?.reasons) ? verification.reasons : [];
  const policy = effectivePolicyForTabSync(state?.tabId);
  const modelAllowed = Boolean(
    verification?.model && policy.lockedModels.includes(verification.model),
  );
  if (verification?.verdict === 'verified') return { outcome: 'verified', reason: null };
  if (reasons.includes('model_not_allowed')) {
    return { outcome: 'model_mismatch', reason: 'confirmed_model_mismatch' };
  }
  if (modelAllowed && reasons.includes('reasoning_missing')) {
    return { outcome: 'model_verified_reasoning_unconfirmed', reason: 'reasoning_not_exposed' };
  }
  if (timedOut) return { outcome: 'unverified', reason: 'response_verification_timeout' };
  if (state.evidenceIssue === 'response_body_read_failed') {
    return { outcome: 'unverified', reason: 'response_body_read_failed' };
  }
  if (state.streamTracking?.handoff) {
    if ((state.streamTracking.downstreamEvidenceCount || 0) === 0) {
      return { outcome: 'unverified', reason: 'stream_handoff_followup_not_observed' };
    }
    if (state.evidenceIssue === 'response_model_not_exposed' || reasons.includes('model_missing')) {
      return { outcome: 'unverified', reason: 'downstream_model_not_exposed' };
    }
  }
  if (state.evidenceIssue === 'response_model_not_exposed' || reasons.includes('model_missing')) {
    return { outcome: 'unverified', reason: 'model_not_exposed' };
  }
  if (state.evidenceIssue === 'response_reasoning_not_exposed' || reasons.includes('reasoning_missing')) {
    return { outcome: 'unverified', reason: 'reasoning_not_exposed' };
  }
  if (state.phase === 'error') return { outcome: 'error', reason: state.lastError || 'verification_error' };
  return { outcome: 'unverified', reason: state.evidenceIssue || verification?.reason || 'metadata_incomplete' };
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

    if (requestId && state.lastVerification?.verdict === 'verified') {
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

function probeText(attempt) {
  if (attempt === 1) {
    return 'GPTWork 自动验证 1/2：请计算 37×41，并只回复结果。';
  }
  return 'GPTWork 自动验证 2/2：请计算 137×29，并只回复结果。';
}

async function autoVerify(tabId) {
  if (!currentSettings.enabled) throw new Error('GPTWork is disabled / GPTWork 已关闭');
  const tab = await chrome.tabs.get(tabId);
  if (!isChatGptUrl(tab.url ?? '')) throw new Error('Open chatgpt.com first / 请先打开 chatgpt.com');
  const state = ensureTabState(tabId, tab.url);
  const startedAt = new Date().toISOString();
  logRuntime('info', 'verification', 'auto_verify_started', {
    tabId,
    maxAttempts: AUTO_VERIFY_MAX_ATTEMPTS,
  });

  const coreCheck = await refreshNativeCore({ tolerateFailure: true });
  const monitorAttached = await networkMonitor.attach(tabId);
  const page = await collectPageObservation(tabId, state);

  state.autoVerification = {
    running: true,
    startedAt,
    completedAt: null,
    attempt: 0,
    maxAttempts: AUTO_VERIFY_MAX_ATTEMPTS,
    retries: 0,
    outcome: 'running',
    reason: null,
    requestLockConfirmed: false,
    requestModel: null,
    responseModel: null,
    responseReasoning: null,
    evidenceSource: null,
    attempts: [],
  };
  try {
    await startAutoVerificationStreamCapture(tabId, startedAt);
  } catch (error) {
    logRuntime('warn', 'diagnostics', 'auto_verify_stream_capture_start_failed', { tabId, error: errorText(error) });
  }
  resetVerificationAttempt(state);
  state.lastError = page.error;
  await broadcastTabState(tabId);

  if (!monitorAttached) {
    logRuntime('warn', 'verification', 'auto_verify_request_lock_unavailable', {
      tabId,
      monitorError: state.monitor?.error ?? null,
    });
  }

  for (let attempt = 1; attempt <= AUTO_VERIFY_MAX_ATTEMPTS; attempt += 1) {
    resetVerificationAttempt(state);
    state.autoVerification.running = true;
    state.autoVerification.attempt = attempt;
    state.autoVerification.retries = attempt - 1;
    state.autoVerification.reason = attempt > 1 ? 'retrying_after_incomplete_evidence' : null;
    await broadcastTabState(tabId);

    const attemptStartedMs = Date.now();
    let sendResult = null;
    let sendError = null;
    try {
      sendResult = await sendTabMessage(tabId, {
        type: 'GPTLOCK_AUTO_SEND_PROBE',
        preferredReasoning: currentSettings.preferredReasoning,
        probeText: probeText(attempt),
        probeMarker: `GPTWork 自动验证 ${attempt}/2`,
      });
    } catch (error) {
      sendError = errorText(error);
      state.lastError = sendError;
      logRuntime('error', 'verification', 'auto_probe_send_failed', {
        tabId,
        attempt,
        error: sendError,
        monitorAttached,
      });
    }

    if (sendError || !sendResult?.sent) {
      state.autoVerification.attempts.push({
        attempt,
        sent: false,
        sendError: sendError || 'visible_probe_not_sent',
        requestLockConfirmed: false,
        outcome: 'send_failed',
        reason: sendError || 'visible_probe_not_sent',
      });
      if (attempt < AUTO_VERIFY_MAX_ATTEMPTS) {
        logRuntime('warn', 'verification', 'auto_verify_retry_scheduled', {
          tabId,
          attempt,
          reason: sendError || 'visible_probe_not_sent',
        });
        await sleep(1000);
        continue;
      }
      break;
    }

    logRuntime('info', 'verification', 'auto_probe_send_completed', {
      tabId,
      attempt,
      sent: true,
      method: sendResult.method ?? null,
      draftPreserved: Boolean(sendResult.draftPreserved),
      draftRestored: Boolean(sendResult.draftRestored),
      coreConnected: coreCheck.connected,
      coreError: coreCheck.error,
      monitorAttached,
      pageCollected: page.collected,
      pageCollectionError: page.error,
    });

    const waited = await waitForAttemptVerification(tabId, attemptStartedMs);
    if (waited.timedOut) {
      state.phase = 'unverified';
      state.evidenceIssue = 'auto_verify_response_timeout';
      state.lastError = 'response_verification_timeout';
      logRuntime('warn', 'verification', 'auto_verify_response_timeout', {
        tabId,
        attempt,
        requestId: waited.requestId,
        timeoutMs: AUTO_VERIFY_RESPONSE_TIMEOUT_MS,
      });
      await broadcastTabState(tabId);
    } else if (state.lastVerification?.verdict !== 'verified') {
      logRuntime('info', 'verification', 'conversation_fallback_skipped', {
        tabId,
        attempt,
        reason: 'deprecated_after_stream_handoff_tracking',
        handoffSettled: Boolean(waited.handoffSettled),
        downstreamEvidenceCount: state.streamTracking?.downstreamEvidenceCount || 0,
      });
    }

    const requestLocked = requestLockConfirmed(state);
    const outcome = verificationOutcome(state, { timedOut: waited.timedOut });
    const attemptSummary = {
      attempt,
      sent: true,
      requestLockConfirmed: requestLocked,
      requestModel: state.lastRequest?.model ?? null,
      rewriteReason: state.lastRewrite?.reason ?? null,
      responseModel: state.lastVerification?.model ?? null,
      responseReasoning: state.lastVerification?.reasoning ?? null,
      evidenceSource: state.lastVerification?.evidenceSource ?? null,
      verdict: state.lastVerification?.verdict ?? null,
      evidenceIssue: state.evidenceIssue ?? null,
      streamTracking: state.streamTracking ? { ...state.streamTracking } : null,
      timedOut: waited.timedOut,
      outcome: outcome.outcome,
      reason: outcome.reason,
    };
    state.autoVerification.attempts.push(attemptSummary);
    state.autoVerification.requestLockConfirmed = requestLocked;
    state.autoVerification.requestModel = attemptSummary.requestModel;
    state.autoVerification.responseModel = attemptSummary.responseModel;
    state.autoVerification.responseReasoning = attemptSummary.responseReasoning;
    state.autoVerification.evidenceSource = attemptSummary.evidenceSource;
    state.autoVerification.outcome = outcome.outcome;
    state.autoVerification.reason = outcome.reason;
    await broadcastTabState(tabId);

    if (outcome.outcome === 'verified') break;
    if (attempt < AUTO_VERIFY_MAX_ATTEMPTS) {
      logRuntime('warn', 'verification', 'auto_verify_retry_scheduled', {
        tabId,
        attempt,
        nextAttempt: attempt + 1,
        reason: outcome.reason,
        requestLockConfirmed: requestLocked,
      });
      await sleep(1000);
    }
  }

  const attempts = state.autoVerification.attempts;
  const lastAttempt = attempts[attempts.length - 1] ?? null;
  const finalOutcome = lastAttempt?.outcome ?? 'error';
  const finalReason = lastAttempt?.reason ?? state.lastError ?? 'auto_verify_failed';
  state.autoVerification.running = false;
  state.autoVerification.completedAt = new Date().toISOString();
  state.autoVerification.outcome = finalOutcome;
  state.autoVerification.reason = finalReason;
  state.autoVerification.retries = Math.max(0, attempts.length - 1);
  state.autoVerification.requestLockConfirmed = Boolean(lastAttempt?.requestLockConfirmed);
  state.autoVerification.requestModel = lastAttempt?.requestModel ?? null;
  state.autoVerification.responseModel = lastAttempt?.responseModel ?? null;
  state.autoVerification.responseReasoning = lastAttempt?.responseReasoning ?? null;
  state.autoVerification.evidenceSource = lastAttempt?.evidenceSource ?? null;
  try {
    await finalizeAutoVerificationStreamCapture(tabId, state.autoVerification.completedAt);
  } catch (error) {
    logRuntime('warn', 'diagnostics', 'auto_verify_stream_capture_finalize_failed', { tabId, error: errorText(error) });
  }
  await broadcastTabState(tabId);

  logRuntime(finalOutcome === 'verified' ? 'info' : 'warn', 'verification', 'auto_verify_completed', {
    tabId,
    outcome: finalOutcome,
    reason: finalReason,
    attempts: attempts.length,
    retries: state.autoVerification.retries,
    requestLockConfirmed: state.autoVerification.requestLockConfirmed,
    requestModel: state.autoVerification.requestModel,
    responseModel: state.autoVerification.responseModel,
    responseReasoning: state.autoVerification.responseReasoning,
    evidenceSource: state.autoVerification.evidenceSource,
  });

  return {
    ready: Boolean(lastAttempt?.sent),
    sent: Boolean(lastAttempt?.sent),
    outcome: finalOutcome,
    reason: finalReason,
    attempts: attempts.length,
    retries: state.autoVerification.retries,
    requestLockConfirmed: state.autoVerification.requestLockConfirmed,
    requestModel: state.autoVerification.requestModel,
    responseModel: state.autoVerification.responseModel,
    responseReasoning: state.autoVerification.responseReasoning,
    evidenceSource: state.autoVerification.evidenceSource,
    checks: {
      coreConnected: coreCheck.connected,
      coreError: coreCheck.error,
      monitorAttached,
      pageCollected: page.collected,
      pageCollectionError: page.error,
      pageModel: state.pageObservation?.model ?? null,
      pageReasoning: state.pageObservation?.reasoning ?? null,
    },
    autoVerification: state.autoVerification,
    tabState: publicTabState(state),
  };
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
    lastEvidenceDiagnostics: state.lastEvidenceDiagnostics,
    streamTracking: state.streamTracking,
    evidenceIssue: state.evidenceIssue,
    lastError: state.lastError,
    autoVerification: state.autoVerification,
    updatedAt: state.updatedAt,
    guard: guardFor(state),
  };
}

async function createDiagnosticBundle() {
  const [stored, runtimeLogs, platform] = await Promise.all([
    chrome.storage.local.get(['nativeStatus', DIAGNOSTIC_SSE_STORAGE_KEY]),
    getRuntimeLogs(),
    getPlatformInfo(),
  ]);
  let nativeDiagnostics = null;
  let nativeDiagnosticsError = null;
  try {
    nativeDiagnostics = await sendNative('get_diagnostics', { auditLimit: 1000 });
  } catch (error) {
    nativeDiagnosticsError = errorText(error);
  }
  const rawStreamCapture = stored[DIAGNOSTIC_SSE_STORAGE_KEY] ?? null;
  const safeBundle = sanitizeLogValue({
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
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
  if (alarm.name === RECONNECT_ALARM) void initialize();
  if (alarm.name === ACCOUNT_REFRESH_ALARM) void refreshAccountHeartbeat();
});

chrome.windows.onCreated.addListener(() => void refreshAccountHeartbeat());
chrome.windows.onRemoved.addListener(() => void refreshAccountHeartbeat());

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
  if (policyChanged) {
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
    void broadcastTabState(state.tabId);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;
  if (TAB_FEATURE_MESSAGE_TYPES.has(message.type)) return false;

  const run = async () => {
    switch (message.type) {
      case 'GPTLOCK_GET_STATE': {
        const tabId = Number.isInteger(message.tabId)
          ? message.tabId
          : sender.tab?.id ?? await activeTabId();
        const { nativeStatus } = await chrome.storage.local.get('nativeStatus');
        const state = tabId === null ? null : tabStates.get(tabId);
        if (tabId !== null && state && isChatGptUrl(state.url)) {
          await collectPageObservation(tabId, state);
        }
        return {
          policy: state ? effectivePolicyForTabSync(state.tabId) : currentPolicy,
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
        const previousPort = nativePort;
        nativePort = null;
        rejectPending(new Error('Native host reconnect requested'));
        previousPort?.disconnect();
        await initialize();
        logRuntime('info', 'native', 'manual_reconnect_completed');
        return { ok: true };
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
      case 'GPTLOCK_CONTEXT_CHANGED': {
        if (!sender.tab?.id) throw new Error('Context update requires a tab');
        const state = ensureTabState(sender.tab.id, message.url || sender.tab.url);
        await broadcastTabState(sender.tab.id);
        return publicTabState(state);
      }
      case 'GPTLOCK_SEND_STARTED': {
        if (!sender.tab?.id) throw new Error('Send event requires a tab');
        const state = ensureTabState(sender.tab.id, sender.tab.url);
        const guard = guardFor(state);
        if (!guard.canSend) {
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
        logRuntime('info', 'verification', 'legacy_probe_reset', { tabId });
        await broadcastTabState(tabId);
        return publicTabState(state);
      }
      case 'GPTLOCK_AUTO_VERIFY': {
        const tabId = await chatGptTabId(Number.isInteger(message.tabId) ? message.tabId : null);
        if (tabId === null) throw new Error('No ChatGPT tab / 没有打开的 ChatGPT 标签页');
        const state = tabStates.get(tabId);
        if (!state || !accountAllowsState(state)) throw new Error('当前账号没有有效权益');
        return autoVerify(tabId);
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
          ? effectivePolicyForTabSync(sender.tab.id)
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
        const bundle = await createDiagnosticBundle();
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