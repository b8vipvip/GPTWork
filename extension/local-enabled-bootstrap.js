const LOCAL_ENABLED_KEY = 'gptworkEnabledLocal';
const RETRY_DELAYS_MS = [80, 300, 1000, 2500, 5000];

let applyTimer = null;
let applying = false;

function isSyncQuotaError(error) {
  return /MAX_WRITE_OPERATIONS_PER_HOUR|MAX_WRITE_OPERATIONS_PER_MINUTE|quota/i.test(String(error?.message || error || ''));
}

function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || 'Extension request failed'));
        return;
      }
      resolve(response.data);
    });
  });
}

async function localEnabled() {
  const stored = await chrome.storage.local.get(LOCAL_ENABLED_KEY);
  return typeof stored?.[LOCAL_ENABLED_KEY] === 'boolean' ? stored[LOCAL_ENABLED_KEY] : null;
}

async function applyLocalEnabled() {
  if (applying) return;
  applying = true;
  try {
    const desired = await localEnabled();
    if (desired === null) return;

    let state = null;
    try {
      state = await runtimeMessage({ type: 'GPTLOCK_GET_STATE' });
    } catch {
      return;
    }
    if (Boolean(state?.settings?.enabled) === desired) return;

    try {
      await runtimeMessage({ type: 'GPTLOCK_SET_ENABLED', enabled: desired });
    } catch (error) {
      // GPTLOCK_SET_ENABLED mutates the running settings before its legacy sync
      // persistence step. A sync quota failure is therefore recoverable: keep the
      // local master switch authoritative and explicitly reconfigure open tabs.
      if (!isSyncQuotaError(error)) return;
    }

    try {
      await runtimeMessage({ type: 'GPTLOCK_ACCOUNT_REFRESH' });
    } catch {
      // A later retry will re-apply the local state if startup is still in flight.
    }
  } finally {
    applying = false;
  }
}

function scheduleApply(delay = 0) {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    void applyLocalEnabled();
  }, delay);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[LOCAL_ENABLED_KEY]) {
    scheduleApply(0);
    return;
  }
  // A synchronized settings change can temporarily restore the legacy synced
  // enabled bit inside background.js. Re-assert the device-local master switch.
  if (areaName === 'sync' && changes.settings) scheduleApply(40);
});

for (const delay of RETRY_DELAYS_MS) {
  setTimeout(() => void applyLocalEnabled(), delay);
}
