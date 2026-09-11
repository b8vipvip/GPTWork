import { ChatGptNetworkMonitor } from './network-monitor.js';
import { appendRuntimeLog } from './runtime-log.js';

const WORK_MODE_KEY = 'gptworkWorkModeEnabled';
const MODEL_LOCK_KEY = 'gptworkModelLockEnabled';
const originalAttach = ChatGptNetworkMonitor.prototype.attach;

function log(event, details = {}, level = 'info') {
  void appendRuntimeLog(level, 'network-safety', event, details).catch(() => {});
}

async function featureGateEnabled() {
  try {
    const stored = await chrome.storage.local.get([WORK_MODE_KEY, MODEL_LOCK_KEY]);
    return stored[WORK_MODE_KEY] === true || stored[MODEL_LOCK_KEY] === true;
  } catch (error) {
    log('feature_gate_read_failed', {
      error: error instanceof Error ? error.message : String(error),
    }, 'warn');
    return false;
  }
}

ChatGptNetworkMonitor.prototype.attach = async function safeAttach(tabId) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    log('monitor_attach_tab_lookup_failed', {
      tabId,
      error: error instanceof Error ? error.message : String(error),
    }, 'warn');
    return false;
  }

  // Never attach Chrome Debugger while the top-level ChatGPT document is loading.
  // The previous behavior could attach from the tabs.onUpdated URL event before the
  // page finished navigation, leaving that tab in a bad debugger/network state. The
  // existing tabs.onUpdated status=complete path will call attach again afterwards.
  if (tab?.status === 'loading') {
    if (this.isAttached?.(tabId)) {
      try {
        await this.detach(tabId);
      } catch (error) {
        log('monitor_detach_during_navigation_failed', {
          tabId,
          error: error instanceof Error ? error.message : String(error),
        }, 'warn');
      }
    }
    log('monitor_attach_deferred_loading', { tabId, status: tab.status });
    return false;
  }

  // Work mode / Model Lock are the product-level source of truth. A stale legacy
  // gptworkEnabledLocal=true value must never be enough to attach a debugger after
  // the extension is disabled/re-enabled from chrome://extensions.
  if (!(await featureGateEnabled())) {
    if (this.isAttached?.(tabId)) {
      try { await this.detach(tabId); } catch {}
    }
    log('monitor_attach_suppressed_no_feature_gate', { tabId, status: tab?.status ?? null });
    return false;
  }

  log('monitor_attach_allowed', { tabId, status: tab?.status ?? null });
  return originalAttach.call(this, tabId);
};
