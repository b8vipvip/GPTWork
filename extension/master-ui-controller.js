(() => {
  const MASTER_KEY = 'gptworkEnabledLocal';
  const QUOTA_MESSAGE = '当前账户并发窗口超限';
  const masterToggle = document.querySelector('#enabled[data-gptwork-master-toggle="true"]');
  const masterHost = masterToggle?.closest('.master-toggle') || masterToggle?.parentElement || null;
  let quotaExceeded = false;
  let syncTimers = [];
  let toastTimer = null;

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

  function clearSyncTimers() {
    for (const timer of syncTimers) clearTimeout(timer);
    syncTimers = [];
  }

  function quotaToast() {
    let node = document.getElementById('gptwork-master-quota-toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'gptwork-master-quota-toast';
      node.style.cssText = 'position:fixed;right:16px;top:68px;z-index:2147483647;max-width:230px;padding:6px 9px;border:1px solid rgba(220,38,38,.22);border-radius:8px;background:rgba(254,242,242,.98);color:#b91c1c;box-shadow:0 8px 24px rgba(15,23,42,.14);font:600 11px/1.4 system-ui,sans-serif;pointer-events:none;opacity:0;transform:translateY(-2px);transition:opacity .12s ease,transform .12s ease';
      node.textContent = QUOTA_MESSAGE;
      document.body.append(node);
    }
    clearTimeout(toastTimer);
    node.style.opacity = '1';
    node.style.transform = 'translateY(0)';
    toastTimer = setTimeout(() => {
      node.style.opacity = '0';
      node.style.transform = 'translateY(-2px)';
    }, 1800);
  }

  function applyQuotaUi(exceeded) {
    quotaExceeded = exceeded === true;
    const title = quotaExceeded ? QUOTA_MESSAGE : 'GPTWork 总开关 / GPTWork master switch';
    if (masterToggle) masterToggle.title = title;
    if (masterHost) masterHost.title = title;
  }

  function applyMasterValue(enabled) {
    if (!masterToggle) return;
    masterToggle.checked = Boolean(enabled);
    masterToggle.disabled = false;
  }

  async function syncMasterFromRuntime() {
    if (!masterToggle) return;
    try {
      const snapshot = await runtimeMessage({ type: 'GPTWORK_MASTER_STATUS' });
      applyMasterValue(snapshot?.masterEnabled === true);
      applyQuotaUi(snapshot?.windowQuotaExceeded === true);
    } catch {
      // Keep the last visible state; storage/background synchronization can recover it.
    }
  }

  function scheduleMasterSync() {
    clearSyncTimers();
    syncTimers = [0, 80, 300, 800].map((delay) => setTimeout(() => void syncMasterFromRuntime(), delay));
  }

  async function changeMaster(desired) {
    if (!masterToggle) return;
    const previous = !desired;
    if (desired && quotaExceeded) {
      masterToggle.checked = previous;
      quotaToast();
      return;
    }
    masterToggle.disabled = true;
    try {
      const snapshot = await runtimeMessage({ type: 'GPTWORK_MASTER_SET', enabled: desired });
      applyMasterValue(snapshot?.masterEnabled === true);
      applyQuotaUi(snapshot?.windowQuotaExceeded === true);
    } catch (error) {
      masterToggle.checked = previous;
      masterToggle.disabled = false;
      if (error?.code === 'WINDOW_QUOTA_EXCEEDED' || error?.message === QUOTA_MESSAGE) {
        applyQuotaUi(true);
        quotaToast();
      }
    } finally {
      scheduleMasterSync();
    }
  }

  if (masterToggle) {
    masterToggle.addEventListener('change', (event) => {
      event.stopImmediatePropagation();
      void changeMaster(Boolean(masterToggle.checked));
    }, true);
  }

  masterHost?.addEventListener('mouseenter', () => {
    if (quotaExceeded) quotaToast();
  });
  masterHost?.addEventListener('click', () => {
    if (quotaExceeded) quotaToast();
  }, true);

  window.addEventListener('gptlock-account-refresh', scheduleMasterSync);
  window.addEventListener('gptlock-account-changed', scheduleMasterSync);
  window.addEventListener('focus', scheduleMasterSync);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[MASTER_KEY]) return;
    applyMasterValue(changes[MASTER_KEY].newValue === true);
    scheduleMasterSync();
  });

  scheduleMasterSync();
})();
