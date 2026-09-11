(() => {
  const MASTER_KEY = 'gptworkEnabledLocal';
  const masterToggle = document.querySelector('#enabled[data-gptwork-master-toggle="true"]');
  const workToggle = document.getElementById('workModeEnabled');
  const modelToggle = document.getElementById('modelLockEnabled');
  let explicitMasterIntentUntil = 0;
  let syncTimers = [];

  function clearSyncTimers() {
    for (const timer of syncTimers) clearTimeout(timer);
    syncTimers = [];
  }

  function applyMasterValue(enabled) {
    if (!masterToggle) return;
    masterToggle.checked = Boolean(enabled);
  }

  function syncMasterFromRuntime() {
    if (!masterToggle) return;
    chrome.runtime.sendMessage({ type: 'GPTLOCK_GET_STATE' }, (response) => {
      const error = chrome.runtime.lastError;
      if (error || !response?.ok) return;
      applyMasterValue(response.data?.settings?.enabled !== false);
    });
  }

  function scheduleMasterSync() {
    clearSyncTimers();
    syncTimers = [0, 60, 250, 700].map((delay) => setTimeout(syncMasterFromRuntime, delay));
  }

  if (masterToggle) {
    masterToggle.addEventListener('change', () => {
      explicitMasterIntentUntil = Date.now() + 1500;
    }, true);
  }

  for (const featureToggle of [workToggle, modelToggle]) {
    featureToggle?.addEventListener('change', scheduleMasterSync, true);
  }

  window.addEventListener('gptlock-account-refresh', scheduleMasterSync);
  window.addEventListener('gptlock-account-changed', scheduleMasterSync);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[MASTER_KEY]) return;
    applyMasterValue(changes[MASTER_KEY].newValue === true);
    if (masterToggle) masterToggle.disabled = false;
  });

  try {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message?.type === 'GPTLOCK_SET_ENABLED') {
        const explicitMasterAction = Boolean(
          masterToggle
          && Date.now() <= explicitMasterIntentUntil
          && Boolean(message.enabled) === Boolean(masterToggle.checked),
        );
        if (!explicitMasterAction) {
          // Work mode and Model lock are subordinate feature gates. Legacy controllers
          // still ask to derive the master state from their OR value; convert that old
          // request into a harmless account/tab refresh so only the visible master
          // switch can start or stop GPTWork globally.
          scheduleMasterSync();
          return originalSendMessage({ type: 'GPTLOCK_ACCOUNT_REFRESH' }, ...args);
        }

        // popup.js temporarily disables the checkbox while the background persists the
        // master state. Wrap its callback so the control is always usable again after
        // the request finishes, including error responses.
        const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
        if (callbackIndex >= 0) {
          const callback = args[callbackIndex];
          args[callbackIndex] = (...callbackArgs) => {
            if (masterToggle) masterToggle.disabled = false;
            callback(...callbackArgs);
            scheduleMasterSync();
          };
        }
      }
      return originalSendMessage(message, ...args);
    };
  } catch {
    // Background persistence remains authoritative if this compatibility patch cannot install.
  }

  scheduleMasterSync();
})();
