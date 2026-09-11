const SETTINGS_RUNTIME_KEY = 'gptlockSettingsRuntimeInfo';
const UPDATE_STATUS_KEY = 'gptlockUiUpdateStatus';
const MASTER_KEY = 'gptworkEnabledLocal';
const SETTINGS_REVISION = 'v0555-settings-master-switch';
const SAFE_CORE_RECONCILE_PHASES = new Set(['idle', 'checking', 'ready', 'up_to_date', 'error']);
const MASTER_MESSAGE_SOURCE = 'settings_master';
let masterSyncTimers = [];

// Legacy feature code still asks GPTLOCK_SET_ENABLED to mirror Work/Model-lock OR
// state. Those requests must never override the independent GPTWork master switch.
// The Settings master control is the only settings-page caller allowed through.
try {
  const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (message, ...args) => {
    if (message?.type === 'GPTLOCK_SET_ENABLED' && message?.source !== MASTER_MESSAGE_SOURCE) {
      return originalSendMessage({ type: 'GPTLOCK_ACCOUNT_REFRESH' }, ...args);
    }
    return originalSendMessage(message, ...args);
  };
} catch {
  // Best effort compatibility bridge.
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

function setSettingsMessage(text, tone = '') {
  const node = document.getElementById('formMessage');
  if (!node) return;
  node.textContent = text || '';
  node.className = tone === 'bad' ? 'inline-message bad' : tone === 'good' ? 'inline-message good' : '';
}

function syncSettingsMasterFromRuntime() {
  const master = document.getElementById('enabled');
  if (!master) return;
  void getRuntimeState()
    .then((state) => {
      master.checked = state?.settings?.enabled !== false;
    })
    .catch(() => {});
}

function scheduleSettingsMasterSync() {
  for (const timer of masterSyncTimers) clearTimeout(timer);
  masterSyncTimers = [0, 60, 250, 700].map((delay) => setTimeout(syncSettingsMasterFromRuntime, delay));
}

function installSettingsMasterControl() {
  const master = document.getElementById('enabled');
  const section = document.getElementById('globalHeading')?.closest('section');
  if (!master || !section) return;

  master.hidden = false;
  master.removeAttribute('aria-hidden');
  master.removeAttribute('tabindex');
  master.dataset.gptworkMasterToggle = 'true';

  if (!master.closest('[data-gptwork-settings-master="true"]')) {
    const row = document.createElement('label');
    row.className = 'check-row wide';
    row.dataset.gptworkSettingsMaster = 'true';
    row.title = 'GPTWork 总开关 / GPTWork master switch';
    const copy = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = 'GPTWork 总开关';
    const small = document.createElement('small');
    small.textContent = '关闭后立即停止 GPTWork 运行；Work 模式和模型锁定的选择会保留，但不能重新开启总开关。';
    copy.append(strong, small);
    row.append(master, copy);
    const help = section.querySelector('.help');
    if (help) help.insertAdjacentElement('afterend', row);
    else section.prepend(row);
  }

  master.addEventListener('change', (event) => {
    event.stopImmediatePropagation();
    const desired = Boolean(master.checked);
    const previous = !desired;
    master.disabled = true;
    setSettingsMessage(desired ? '正在启用 GPTWork / Enabling…' : '正在关闭 GPTWork / Disabling…');
    chrome.runtime.sendMessage({
      type: 'GPTLOCK_SET_ENABLED',
      enabled: desired,
      source: MASTER_MESSAGE_SOURCE,
    }, (response) => {
      const error = chrome.runtime.lastError;
      master.disabled = false;
      if (error || !response?.ok) {
        master.checked = previous;
        setSettingsMessage(`总开关切换失败 / Master toggle failed: ${error?.message || response?.error || 'unknown error'}`, 'bad');
      } else {
        master.checked = response.data?.settings?.enabled !== false;
        setSettingsMessage(master.checked ? 'GPTWork 已启用 / Enabled.' : 'GPTWork 已关闭 / Disabled.', 'good');
      }
      scheduleSettingsMasterSync();
    });
  }, true);

  for (const featureToggle of [
    document.getElementById('workModeEnabled'),
    document.getElementById('modelLockEnabled'),
  ]) {
    featureToggle?.addEventListener('change', scheduleSettingsMasterSync, true);
  }

  scheduleSettingsMasterSync();
}

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
installSettingsMasterControl();
void persistRuntimeFingerprint();
void reconcileDisplayedCoreVersion();
void import('./model-availability-options.js').catch(() => {});

const observer = new MutationObserver(() => removeLegacyLicenseUi());
observer.observe(document.documentElement, { childList: true, subtree: true });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[MASTER_KEY]) {
    const master = document.getElementById('enabled');
    if (master) {
      master.checked = changes[MASTER_KEY].newValue === true;
      master.disabled = false;
    }
  }
  if (areaName === 'local' && changes[UPDATE_STATUS_KEY]) {
    window.setTimeout(() => void reconcileDisplayedCoreVersion(), 0);
  }
});

window.addEventListener('gptlock-account-refresh', scheduleSettingsMasterSync);
window.addEventListener('gptlock-account-changed', scheduleSettingsMasterSync);
window.addEventListener('pageshow', () => {
  removeLegacyLicenseUi();
  scheduleSettingsMasterSync();
  void reconcileDisplayedCoreVersion();
});
window.addEventListener('unload', () => {
  for (const timer of masterSyncTimers) clearTimeout(timer);
  observer.disconnect();
}, { once: true });
