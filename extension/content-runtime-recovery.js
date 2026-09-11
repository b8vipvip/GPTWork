import { appendRuntimeLog } from './runtime-log.js';

const MASTER_KEY = 'gptworkEnabledLocal';
const CONTENT_SCRIPT_FILES = [
  'floating-ui-master-state.js',
  'content-local-error-capture.js',
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
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function contentRuntimeReady(tabId) {
  try {
    const response = await sendTabMessage(tabId, { type: 'GPTLOCK_COLLECT_PAGE_STATE' });
    return Boolean(response?.ok && response?.observation);
  } catch {
    return false;
  }
}

export async function ensureContentRuntime(tabId, reason = 'unspecified') {
  if (!Number.isInteger(tabId)) return { ready: false, injected: false, reason: 'invalid_tab' };
  if (recoveryByTab.has(tabId)) return recoveryByTab.get(tabId);

  const task = (async () => {
    if (!await masterRuntimeEnabled()) {
      return { ready: false, injected: false, reason: 'master_disabled' };
    }

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      return { ready: false, injected: false, reason: 'tab_lookup_failed', error: error.message };
    }
    if (!isChatGptUrl(tab?.url || '')) return { ready: false, injected: false, reason: 'outside_scope' };
    if (tab.status === 'loading') {
      log('info', 'content_recovery_deferred_loading', { tabId, reason });
      return { ready: false, injected: false, reason: 'tab_loading' };
    }
    if (await contentRuntimeReady(tabId)) return { ready: true, injected: false, reason: 'already_ready' };

    // Re-check immediately before injection in case the user turned the master off
    // while this recovery task was looking up the tab.
    if (!await masterRuntimeEnabled()) {
      return { ready: false, injected: false, reason: 'master_disabled' };
    }

    log('warn', 'content_runtime_missing', {
      tabId,
      reason,
      status: tab.status ?? null,
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
      if (await contentRuntimeReady(tabId)) {
        log('info', 'content_runtime_recovered', { tabId, reason, attempt });
        return { ready: true, injected: true, reason: 'recovered' };
      }
      await new Promise((resolve) => setTimeout(resolve, 120 * attempt));
    }

    log('error', 'content_runtime_injected_but_unreachable', { tabId, reason });
    return { ready: false, injected: true, reason: 'receiver_unreachable' };
  })().finally(() => recoveryByTab.delete(tabId));

  recoveryByTab.set(tabId, task);
  return task;
}

async function recoverOpenTabs(reason) {
  if (!await masterRuntimeEnabled()) return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  } catch (error) {
    log('warn', 'content_recovery_query_failed', { reason, error: error.message });
    return;
  }
  await Promise.allSettled(tabs.map((tab) => ensureContentRuntime(tab.id, reason)));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isChatGptUrl(tab?.url || '')) {
    void ensureContentRuntime(tabId, 'tab_complete');
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void ensureContentRuntime(tabId, 'tab_activated');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[MASTER_KEY]) return;
  if (changes[MASTER_KEY].newValue === true) void recoverOpenTabs('master_enabled');
});

// Wait until background.js has registered its GPTLOCK_* receiver before injecting
// content.js, because content.js immediately requests GPTLOCK_GET_STATE on startup.
setTimeout(() => void recoverOpenTabs('service_worker_start'), 250);
