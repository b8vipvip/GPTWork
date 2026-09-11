import { appendRuntimeLog } from './runtime-log.js';

const MASTER_KEY = 'gptworkEnabledLocal';
const RECONNECT_ALARM = 'gptlock-native-reconnect';
const ACCOUNT_REFRESH_ALARM = 'gptlock-account-refresh';
const MASTER_RUNTIME_ALARMS = new Set([RECONNECT_ALARM, ACCOUNT_REFRESH_ALARM]);
const CHATGPT_URL = 'https://chatgpt.com/*';

let masterEnabled = false;
let masterResolved = false;
let restartTimer = null;
const nativePorts = new Set();

function log(level, event, details = {}) {
  void appendRuntimeLog(level, 'master-runtime', event, details).catch(() => {});
}

function patchFunction(target, key, factory) {
  try {
    const original = target?.[key];
    if (typeof original !== 'function') return false;
    const patched = factory(original.bind(target));
    target[key] = patched;
    return target[key] === patched;
  } catch (error) {
    log('warn', 'api_patch_failed', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

const connectNativePatched = patchFunction(chrome.runtime, 'connectNative', (original) => (...args) => {
  if (!masterEnabled) {
    throw new Error('GPTWork master switch is off / GPTWork 总开关已关闭');
  }
  const port = original(...args);
  nativePorts.add(port);
  try {
    port.onDisconnect.addListener(() => nativePorts.delete(port));
  } catch {
    // Best effort tracking only.
  }
  return port;
});

const alarmCreatePatched = patchFunction(chrome.alarms, 'create', (original) => (name, alarmInfo) => {
  if (!masterEnabled && MASTER_RUNTIME_ALARMS.has(String(name || ''))) return undefined;
  return original(name, alarmInfo);
});

function patchWindowEvent(event, eventName) {
  if (!event || typeof event.addListener !== 'function') return false;
  return patchFunction(event, 'addListener', (original) => (listener, ...rest) => {
    if (typeof listener !== 'function') return original(listener, ...rest);
    const guarded = (...args) => {
      if (!masterEnabled) return undefined;
      return listener(...args);
    };
    return original(guarded, ...rest);
  }) || (log('warn', 'window_event_guard_unavailable', { eventName }), false);
}

const windowCreatedPatched = patchWindowEvent(chrome.windows?.onCreated, 'onCreated');
const windowRemovedPatched = patchWindowEvent(chrome.windows?.onRemoved, 'onRemoved');

async function clearRuntimeAlarms() {
  await Promise.allSettled([
    chrome.alarms.clear(RECONNECT_ALARM),
    chrome.alarms.clear(ACCOUNT_REFRESH_ALARM),
  ]);
}

function disconnectNativePorts() {
  const ports = [...nativePorts];
  nativePorts.clear();
  for (const port of ports) {
    try { port.disconnect(); } catch {}
  }
  return ports.length;
}

async function stopTabRuntime(tab) {
  if (!Number.isInteger(tab?.id)) return;
  try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  try { await chrome.action.setBadgeText({ tabId: tab.id, text: '' }); } catch {}
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'GPTLOCK_MASTER_RUNTIME_STATE',
      enabled: false,
    });
  } catch {}
}

async function hardStopRuntime(reason = 'master_disabled') {
  clearTimeout(restartTimer);
  restartTimer = null;
  await clearRuntimeAlarms();
  const disconnectedPorts = disconnectNativePorts();
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: CHATGPT_URL });
  } catch {}
  await Promise.allSettled(tabs.map(stopTabRuntime));

  try {
    const stored = await chrome.storage.local.get('nativeStatus');
    const nativeStatus = stored?.nativeStatus && typeof stored.nativeStatus === 'object'
      ? stored.nativeStatus
      : {};
    await chrome.storage.local.set({
      nativeStatus: {
        ...nativeStatus,
        connected: false,
        lastError: null,
        errorCode: null,
      },
    });
  } catch {}

  log('info', 'master_runtime_stopped', {
    reason,
    tabs: tabs.length,
    disconnectedNativePorts: disconnectedPorts,
  });
}

function sendReconnectAttempt(attempt = 1) {
  if (!masterEnabled) return;
  chrome.runtime.sendMessage({ type: 'GPTLOCK_RECONNECT' }, (response) => {
    const error = chrome.runtime.lastError;
    if (!masterEnabled) return;
    if (!error && response?.ok) {
      log('info', 'master_runtime_started', { attempt });
      return;
    }
    if (attempt >= 4) {
      log('warn', 'master_runtime_restart_failed', {
        attempt,
        error: error?.message || response?.error || 'background_receiver_unavailable',
      });
      return;
    }
    restartTimer = setTimeout(() => sendReconnectAttempt(attempt + 1), 250 * attempt);
  });
}

function startRuntime(reason = 'master_enabled') {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    sendReconnectAttempt(1);
  }, masterResolved ? 60 : 300);
  log('info', 'master_runtime_start_requested', { reason });
}

function applyMasterState(enabled, reason) {
  const next = Boolean(enabled);
  const changed = masterResolved && masterEnabled !== next;
  masterEnabled = next;
  masterResolved = true;
  if (!next) {
    void hardStopRuntime(reason);
    return;
  }
  if (changed || reason === 'initial_state') startRuntime(reason);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[MASTER_KEY]) return;
  applyMasterState(changes[MASTER_KEY].newValue === true, 'storage_changed');
});

chrome.storage.local.get(MASTER_KEY, (stored) => {
  const error = chrome.runtime.lastError;
  if (error) {
    masterResolved = true;
    masterEnabled = false;
    void hardStopRuntime('initial_state_read_failed');
    return;
  }
  applyMasterState(stored?.[MASTER_KEY] === true, 'initial_state');
});

log('info', 'master_runtime_guard_installed', {
  connectNativePatched,
  alarmCreatePatched,
  windowCreatedPatched,
  windowRemovedPatched,
});
