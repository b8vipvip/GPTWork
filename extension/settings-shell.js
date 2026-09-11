const SETTINGS_RUNTIME_KEY = 'gptlockSettingsRuntimeInfo';
const UPDATE_STATUS_KEY = 'gptlockUiUpdateStatus';
const MASTER_KEY = 'gptworkEnabledLocal';
const SETTINGS_REVISION = 'v0556-settings-master-tab-isolation';
const SAFE_CORE_RECONCILE_PHASES = new Set(['idle', 'checking', 'ready', 'up_to_date', 'error']);
const QUOTA_MESSAGE = '当前账户并发窗口超限';
let masterSyncTimers = [];
let masterQuotaExceeded = false;
let quotaToastTimer = null;

function runtimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      if (!response?.ok) {
        const requestError = new Error(response?.error || 'Extension request failed');
        requestError.code = response?.code || null;
        return reject(requestError);
      }
      resolve(response.data);
    });
  });
}

function getRuntimeState() {
  return runtimeMessage({ type: 'GPTLOCK_GET_STATE' });
}

function setSettingsMessage(text, tone = '') {
  const node = document.getElementById('formMessage');
  if (!node) return;
  node.textContent = text || '';
  node.className = tone === 'bad' ? 'inline-message bad' : tone === 'good' ? 'inline-message good' : '';
}

function quotaToast() {
  let node = document.getElementById('gptwork-settings-master-quota-toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'gptwork-settings-master-quota-toast';
    node.style.cssText = 'position:fixed;right:24px;top:24px;z-index:2147483647;max-width:260px;padding:8px 11px;border:1px solid rgba(220,38,38,.22);border-radius:9px;background:rgba(254,242,242,.98);color:#b91c1c;box-shadow:0 10px 28px rgba(15,23,42,.14);font:600 12px/1.45 system-ui,sans-serif;pointer-events:none;opacity:0;transform:translateY(-3px);transition:opacity .12s ease,transform .12s ease';
    node.textContent = QUOTA_MESSAGE;
    document.body.append(node);
  }
  clearTimeout(quotaToastTimer);
  node.style.opacity = '1';
  node.style.transform = 'translateY(0)';
  quotaToastTimer = setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(-3px)';
  }, 1900);
}

function applyQuotaUi(exceeded) {
  masterQuotaExceeded = exceeded === true;
  const master = document.getElementById('enabled');
  const row = master?.closest('[data-gptwork-settings-master="true"]');
  const title = masterQuotaExceeded ? QUOTA_MESSAGE : 'GPTWork 总开关 / GPTWork master switch';
  if (master) master.title = title;
  if (row) row.title = title;
}

async function syncSettingsMasterFromRuntime() {
  const master = document.getElementById('enabled');
  if (!master) return;
  try {
    const snapshot = await runtimeMessage({ type: 'GPTWORK_MASTER_STATUS' });
    master.checked = snapshot?.masterEnabled === true;
    master.disabled = false;
    applyQuotaUi(snapshot?.windowQuotaExceeded === true);
  } catch {}
}

function scheduleSettingsMasterSync() {
  for (const timer of masterSyncTimers) clearTimeout(timer);
  masterSyncTimers = [0, 80, 300, 800].map((delay) => setTimeout(() => void syncSettingsMasterFromRuntime(), delay));
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
    small.textContent = '全局总开关：关闭后立即停止 GPTWork。Work 模式与模型锁定仍按每个 ChatGPT 标签页分别保存。';
    copy.append(strong, small);
    row.append(master, copy);
    const help = section.querySelector('.help');
    if (help) help.insertAdjacentElement('afterend', row);
    else section.prepend(row);
  }

  const row = master.closest('[data-gptwork-settings-master="true"]');
  row?.addEventListener('mouseenter', () => {
    if (masterQuotaExceeded) quotaToast();
  });
  row?.addEventListener('click', () => {
    if (masterQuotaExceeded) quotaToast();
  }, true);

  master.addEventListener('change', (event) => {
    event.stopImmediatePropagation();
    const desired = Boolean(master.checked);
    const previous = !desired;
    if (desired && masterQuotaExceeded) {
      master.checked = previous;
      quotaToast();
      setSettingsMessage(QUOTA_MESSAGE, 'bad');
      return;
    }
    master.disabled = true;
    setSettingsMessage(desired ? '正在启用 GPTWork / Enabling…' : '正在关闭 GPTWork / Disabling…');
    void runtimeMessage({ type: 'GPTWORK_MASTER_SET', enabled: desired })
      .then((snapshot) => {
        master.checked = snapshot?.masterEnabled === true;
        applyQuotaUi(snapshot?.windowQuotaExceeded === true);
        setSettingsMessage(master.checked ? 'GPTWork 已启用 / Enabled.' : 'GPTWork 已关闭 / Disabled.', 'good');
      })
      .catch((error) => {
        master.checked = previous;
        if (error?.code === 'WINDOW_QUOTA_EXCEEDED' || error?.message === QUOTA_MESSAGE) {
          applyQuotaUi(true);
          quotaToast();
          setSettingsMessage(QUOTA_MESSAGE, 'bad');
        } else {
          setSettingsMessage(`总开关切换失败 / Master toggle failed: ${error.message}`, 'bad');
        }
      })
      .finally(() => {
        master.disabled = false;
        scheduleSettingsMasterSync();
      });
  }, true);

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
    scheduleSettingsMasterSync();
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
