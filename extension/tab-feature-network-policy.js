import { ChatGptNetworkMonitor } from './network-monitor.js';
import {
  effectivePolicyForTabSync,
  lockConfigurationForTabSync,
} from './tab-feature-runtime.js';
import { appendRuntimeLog } from './runtime-log.js';

const originalConfiguration = ChatGptNetworkMonitor.prototype.configuration;
const originalHandlePausedRequest = ChatGptNetworkMonitor.prototype.handlePausedRequest;
const requestQueues = new WeakMap();

function log(event, details = {}, level = 'info') {
  void appendRuntimeLog(level, 'tab-feature-policy', event, details).catch(() => {});
}

// network-monitor.js historically asked for one global configuration. Serialize paused
// request handling so the existing method can safely read a tab-specific policy without
// leaking another tab's Work/Model-lock state into this request.
ChatGptNetworkMonitor.prototype.configuration = function tabScopedConfiguration() {
  const fallback = originalConfiguration.call(this);
  const tabId = this.__gptworkFeatureTabId;
  if (!Number.isInteger(tabId)) return fallback;
  return lockConfigurationForTabSync(tabId, fallback);
};

ChatGptNetworkMonitor.prototype.handlePausedRequest = function tabScopedPausedRequest(tabId, params) {
  const previous = requestQueues.get(this) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    this.__gptworkFeatureTabId = tabId;
    try {
      return await originalHandlePausedRequest.call(this, tabId, params);
    } finally {
      delete this.__gptworkFeatureTabId;
    }
  });
  requestQueues.set(this, next);
  return next;
};

function tabIdFromVerification(message) {
  const requestId = String(message?.observation?.requestId || '');
  const match = requestId.match(/^cdp-(\d+)-/);
  if (!match) return null;
  const tabId = Number(match[1]);
  return Number.isInteger(tabId) ? tabId : null;
}

// Native verification also used the single persisted policy. Add an optional policy
// override to the existing native message, keyed from the cdp-<tabId>- request id, so
// response evidence is evaluated against the same tab policy that rewrote the request.
try {
  const originalConnectNative = chrome.runtime.connectNative.bind(chrome.runtime);
  chrome.runtime.connectNative = (...args) => {
    const port = originalConnectNative(...args);
    const originalPostMessage = port.postMessage.bind(port);
    port.postMessage = (message) => {
      if (message?.type === 'verify') {
        const tabId = tabIdFromVerification(message);
        if (Number.isInteger(tabId)) {
          const policy = effectivePolicyForTabSync(tabId);
          log('verification_policy_override', { tabId, lockedModels: policy.lockedModels });
          return originalPostMessage({ ...message, policy });
        }
      }
      return originalPostMessage(message);
    };
    return port;
  };
} catch (error) {
  log('native_policy_override_install_failed', {
    error: error instanceof Error ? error.message : String(error),
  }, 'warn');
}
