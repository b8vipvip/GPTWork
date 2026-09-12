import { ChatGptNetworkMonitor } from './network-monitor.js';
import { appendRuntimeLog } from './runtime-log.js';
import { getTabFeatureState } from './tab-feature-runtime.js';

const originalAttach = ChatGptNetworkMonitor.prototype.attach;

function log(event, details = {}, level = 'info') {
  void appendRuntimeLog(level, 'network-safety', event, details).catch(() => {});
}

async function featureGateEnabled(tabId) {
  try {
    const state = await getTabFeatureState(tabId);
    return state.workModeEnabled === true || state.modelLockEnabled === true;
  } catch (error) {
    log('feature_gate_read_failed', {
      tabId,
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

  // Work mode / Model Lock are tab-scoped. A feature enabled in another window/tab
  // must never be enough to attach a debugger to this tab.
  if (!(await featureGateEnabled(tabId))) {
    if (this.isAttached?.(tabId)) {
      try { await this.detach(tabId); } catch {}
    }
    log('monitor_attach_suppressed_no_feature_gate', { tabId, status: tab?.status ?? null });
    return false;
  }

  log('monitor_attach_allowed', { tabId, status: tab?.status ?? null });
  return originalAttach.call(this, tabId);
};
