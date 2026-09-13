const SETTINGS_RUNTIME_KEY = 'gptlockSettingsRuntimeInfo';
const UPDATE_STATUS_KEY = 'gptlockUiUpdateStatus';
const SETTINGS_REVISION = 'v0521-single-authority-1';
const SAFE_CORE_RECONCILE_PHASES = new Set(['idle', 'checking', 'ready', 'up_to_date', 'error']);

function getRuntimeState() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GPTLOCK_GET_STATE' }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || 'Extension request failed'));
      else resolve(response.data);
    });
  });
}

let coreReconcileRunning = false;
async function reconcileDisplayedCoreVersion() {
  if (coreReconcileRunning) return;
  coreReconcileRunning = true;
  try {
    const state = await getRuntimeState();
    const nativeVersion = state?.nativeStatus?.connected ? state.nativeStatus.version : null;
    if (!nativeVersion) return;

    const coreNode = document.getElementById('updateCoreVersion');
    if (coreNode) coreNode.textContent = nativeVersion;

    const stored = await chrome.storage.local.get(UPDATE_STATUS_KEY);
    const status = stored[UPDATE_STATUS_KEY];
    if (!status || !SAFE_CORE_RECONCILE_PHASES.has(status.phase)) return;
    if (status.nativeVersion === nativeVersion) return;
    await chrome.storage.local.set({
      [UPDATE_STATUS_KEY]: {
        ...status,
        nativeVersion,
        coreVersionReconciledAt: new Date().toISOString(),
      },
    });
  } catch {
    // The options/update modules remain authoritative; version reconciliation is display-only.
  } finally {
    coreReconcileRunning = false;
  }
}

async function persistRuntimeFingerprint() {
  try {
    await chrome.storage.local.set({
      [SETTINGS_RUNTIME_KEY]: {
        schemaVersion: 2,
        extensionVersion: chrome.runtime.getManifest().version,
        extensionId: chrome.runtime.id,
        entrypoint: location.pathname.split('/').pop() || location.pathname,
        settingsRevision: SETTINGS_REVISION,
        documentUrl: location.href,
        recordedAt: new Date().toISOString(),
      },
    });
  } catch {
    // Diagnostics are best effort.
  }
}

// Ownership is explicit: master-ui-controller is the only settings-page master writer;
// feature-toggle-controller owns only per-tab Work/Model state.
void import('./master-ui-controller.js').catch(() => {});
void import('./model-availability-options.js').catch(() => {});
void persistRuntimeFingerprint();
void reconcileDisplayedCoreVersion();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[UPDATE_STATUS_KEY]) {
    window.setTimeout(() => void reconcileDisplayedCoreVersion(), 0);
  }
});

window.addEventListener('pageshow', () => {
  void reconcileDisplayedCoreVersion();
});
