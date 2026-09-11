const SETTINGS_RUNTIME_KEY = 'gptlockSettingsRuntimeInfo';
const UPDATE_STATUS_KEY = 'gptlockUiUpdateStatus';
const SETTINGS_REVISION = 'v0554-model-availability-greyout-1';
const SAFE_CORE_RECONCILE_PHASES = new Set(['idle', 'checking', 'ready', 'up_to_date', 'error']);

const LEGACY_LICENSE_SELECTORS = [
  '.license-card',
  '[class~="license-card"]',
  '#licenseHeading',
  '#licenseBadge',
  '#licensePurchase',
  '#licenseDetail',
  '#licenseCode',
  '#licenseActivate',
  '#licenseMessage',
  '[id^="license" i]',
  '[class^="license-" i]',
  '[class*=" license-" i]',
  'input[placeholder^="GPTL-" i]',
];

const LEGACY_LICENSE_TEXT = [
  '授权验证 / License',
  '验证授权码',
  '重新验证',
  '退出授权',
  '获取授权码',
];

function removeLegacyLicenseUi() {
  let removed = false;
  for (const selector of LEGACY_LICENSE_SELECTORS) {
    for (const node of document.querySelectorAll(selector)) {
      const card = node.closest('section, article, .card, .license-card');
      (card || node).remove();
      removed = true;
    }
  }

  for (const node of document.querySelectorAll('section, article')) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (LEGACY_LICENSE_TEXT.some((marker) => text.includes(marker))) {
      node.remove();
      removed = true;
    }
  }
  return removed;
}

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
    // The normal options/update modules remain authoritative; reconciliation is best effort.
  } finally {
    coreReconcileRunning = false;
  }
}

async function persistRuntimeFingerprint() {
  try {
    await chrome.storage.local.set({
      [SETTINGS_RUNTIME_KEY]: {
        schemaVersion: 1,
        extensionVersion: chrome.runtime.getManifest().version,
        extensionId: chrome.runtime.id,
        entrypoint: location.pathname.split('/').pop() || location.pathname,
        settingsRevision: SETTINGS_REVISION,
        documentUrl: location.href,
        legacyLicenseUiRemoved: removeLegacyLicenseUi(),
        recordedAt: new Date().toISOString(),
      },
    });
  } catch {
    // Diagnostics are best effort.
  }
}

removeLegacyLicenseUi();
void persistRuntimeFingerprint();
void reconcileDisplayedCoreVersion();
void import('./model-availability-options.js').catch(() => {});

const observer = new MutationObserver(() => removeLegacyLicenseUi());
observer.observe(document.documentElement, { childList: true, subtree: true });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[UPDATE_STATUS_KEY]) return;
  window.setTimeout(() => void reconcileDisplayedCoreVersion(), 0);
});

window.addEventListener('pageshow', () => {
  removeLegacyLicenseUi();
  void reconcileDisplayedCoreVersion();
});
window.addEventListener('unload', () => observer.disconnect(), { once: true });