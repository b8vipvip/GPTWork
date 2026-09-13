import { appendRuntimeLog } from './runtime-log.js';

const MASTER_KEY = 'gptworkEnabledLocal';
const CONTENT_SCRIPT_FILES = [
  'content-runtime-lifecycle.js',
  'content-local-error-capture.js',
  'floating-ui-master-state.js',
  'page-model-evidence.js',
  'astra-model-evidence.js',
  'context-budget.js',
  'private-context-budget-authority.js',
  'content.js',
  'model-status-history.js',
  'model-catalog.js',
  'work-mode-controller.js',
  'model-status-continuity.js',
  'model-auto-lock.js',
  'multi-window-lock-sync.js',
  'chat-length-hard-limit-semantic.js',
  'chat-length-remaining-indicator.js',
];

const recoveryByTab = new Map();
let recoverySuspended = false;
let recoverySuspendReason = null;
const RECOVERY_CONFIRM_DELAY_MS = 120;
const UPDATE_RECOVERY_GAP_MS = 80;

function isChatGptUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}

function log(level, event, details = {}) {
  void appendRuntimeLog(level, 'content-recovery', event, details).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function masterRuntimeEnabled() {
  try {
    const stored = await chrome.storage.local.get(MASTER_KEY);
    return stored?.[MASTER_KEY] === true;
  } catch {
    return false;
  }
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function contentRuntimeReady(tabId) {
  try {
    const response = await sendTabMessage(tabId, { type: 'GPTLOCK_COLLECT_PAGE_STATE' });
    return Boolean(response?.ok && response?.observation);
  } catch {
    return false;
  }
}

async function contentRuntimeConfirmedMissing(tabId) {
  if (await contentRuntimeReady(tabId)) return false;
  await sleep(RECOVERY_CONFIRM_DELAY_MS);
  return !(await contentRuntimeReady(tabId));
}

async function currentRecoverableTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isChatGptUrl(tab?.url || '')) return { tab: null, reason: 'outside_scope' };
    if (tab.status === 'loading') return { tab: null, reason: 'tab_loading' };
    return { tab, reason: null };
  } catch (error) {
    return {
      tab: null,
      reason: 'tab_lookup_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function ensureContentRuntime(tabId, reason = 'unspecified') {
  if (recoverySuspended) return { ready: false, injected: false, reason: recoverySuspendReason || 'recovery_suspended' };
  if (!Number.isInteger(tabId)) return { ready: false, injected: false, reason: 'invalid_tab' };
  if (recoveryByTab.has(tabId)) return recoveryByTab.get(tabId);

  const task = (async () => {
    if (recoverySuspended) return { ready: false, injected: false, reason: recoverySuspendReason || 'recovery_suspended' };
    if (!await masterRuntimeEnabled()) {
      return { ready: false, injected: false, reason: 'master_disabled' };
    }

    const initial = await currentRecoverableTab(tabId);
    if (!initial.tab) {
      if (initial.reason === 'tab_loading') {
        log('info', 'content_recovery_deferred_loading', { tabId, reason });
      }
      return {
        ready: false,
        injected: false,
        reason: initial.reason,
        ...(initial.error ? { error: initial.error } : {}),
      };
    }

    if (!await contentRuntimeConfirmedMissing(tabId)) {
      return { ready: true, injected: false, reason: 'already_ready' };
    }

    // The tab can navigate or the master can be switched off while the two-step
    // receiver probe is running. Re-check both immediately before injection.
    if (recoverySuspended) return { ready: false, injected: false, reason: recoverySuspendReason || 'recovery_suspended' };
    if (!await masterRuntimeEnabled()) {
      return { ready: false, injected: false, reason: 'master_disabled' };
    }
    const beforeInjection = await currentRecoverableTab(tabId);
    if (!beforeInjection.tab) {
      return {
        ready: false,
        injected: false,
        reason: beforeInjection.reason,
        ...(beforeInjection.error ? { error: beforeInjection.error } : {}),
      };
    }

    log('warn', 'content_runtime_missing_confirmed', {
      tabId,
      reason,
      status: beforeInjection.tab.status ?? null,
      extensionVersion: chrome.runtime.getManifest().version,
    });

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: CONTENT_SCRIPT_FILES,
      });
    } catch (error) {
      log('error', 'content_runtime_injection_failed', {
        tabId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ready: false,
        injected: false,
        reason: 'injection_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      if (!await masterRuntimeEnabled()) {
        return { ready: false, injected: true, reason: 'master_disabled' };
      }
      const current = await currentRecoverableTab(tabId);
      if (!current.tab) {
        return { ready: false, injected: true, reason: current.reason };
      }
      if (await contentRuntimeReady(tabId)) {
        log('info', 'content_runtime_recovered', { tabId, reason, attempt });
        return { ready: true, injected: true, reason: 'recovered' };
      }
      await sleep(120 * attempt);
    }

    log('error', 'content_runtime_injected_but_unreachable', { tabId, reason });
    return { ready: false, injected: true, reason: 'receiver_unreachable' };
  })().finally(() => recoveryByTab.delete(tabId));

  recoveryByTab.set(tabId, task);
  return task;
}

export function suspendContentRecovery(reason = 'runtime_quiescing') {
  recoverySuspended = true;
  recoverySuspendReason = String(reason || 'runtime_quiescing');
  log('info', 'content_recovery_suspended', { reason: recoverySuspendReason });
}

export function resumeContentRecovery() {
  recoverySuspended = false;
  recoverySuspendReason = null;
}

export async function recoverOpenTabs(reason, { onProgress } = {}) {
  if (recoverySuspended) return { total: 0, ready: 0, injected: 0, skipped: 0, results: [], reason: recoverySuspendReason || 'recovery_suspended' };
  if (!await masterRuntimeEnabled()) return { total: 0, ready: 0, injected: 0, skipped: 0, results: [], reason: 'master_disabled' };
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  } catch (error) {
    log('warn', 'content_recovery_query_failed', {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return { total: 0, ready: 0, injected: 0, skipped: 0, results: [], reason: 'query_failed' };
  }

  const candidates = tabs.filter((tab) => Number.isInteger(tab.id));
  const summary = { total: candidates.length, ready: 0, injected: 0, skipped: 0, results: [], reason };

  // Deliberately recover one tab at a time. An extension update can leave dozens of
  // already-open ChatGPT tabs without a current receiver; injecting all of them in a
  // Promise.all burst can create a CPU/memory/debugger storm across every window.
  for (const tab of candidates) {
    if (recoverySuspended || !await masterRuntimeEnabled()) break;
    const result = await ensureContentRuntime(tab.id, reason);
    summary.results.push({ tabId: tab.id, ...result });
    if (result.ready) summary.ready += 1;
    if (result.injected) summary.injected += 1;
    if (!result.ready) summary.skipped += 1;
    if (typeof onProgress === 'function') {
      await onProgress({ ...summary, results: [...summary.results] });
    }
    await sleep(UPDATE_RECOVERY_GAP_MS);
  }
  return summary;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isChatGptUrl(tab?.url || '')) {
    void ensureContentRuntime(tabId, 'tab_complete');
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void ensureContentRuntime(tabId, 'tab_activated');
});

// IMPORTANT: do not sweep and re-inject all open tabs merely because an MV3 service
// worker started. Service workers are routinely suspended and restarted; that event is
// not evidence that the extension was updated. background-update.js owns the one
// runtime-generation recovery sweep after background initialization; this module keeps
// only targeted navigation/activation recovery triggers.
