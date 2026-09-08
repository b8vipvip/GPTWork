const toggle = document.getElementById('enabled');
const message = document.getElementById('message') || document.getElementById('formMessage');

const STORAGE_TIMEOUT_MS = 5000;
const LOCAL_ENABLED_KEY = 'gptworkEnabledLocal';
let busy = false;
let entitlement = { authenticated: null, active: null };

function runtimeMessage(message) {
  const payload = typeof message === 'string' ? { type: message } : message;
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || 'Extension request failed'));
      else resolve(response.data);
    });
  });
}

function withTimeout(promise, ms = STORAGE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => {
      reject(new Error('本地设置写入超时，请重试 / Settings write timed out; please retry'));
    }, ms)),
  ]);
}

function storageGetLocalEnabled() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(LOCAL_ENABLED_KEY, (stored) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(typeof stored?.[LOCAL_ENABLED_KEY] === 'boolean' ? stored[LOCAL_ENABLED_KEY] : null);
    });
  });
}

function storageSetLocalEnabled(enabled) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [LOCAL_ENABLED_KEY]: Boolean(enabled) }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function isSyncQuotaError(error) {
  return /MAX_WRITE_OPERATIONS_PER_HOUR|MAX_WRITE_OPERATIONS_PER_MINUTE|quota/i.test(String(error?.message || error || ''));
}

function syncAvailability() {
  if (!toggle) return;
  const explicitlyDenied = entitlement.authenticated === false
    || (entitlement.authenticated === true && entitlement.active === false);
  // Disabling GPTWork must always remain possible. Entitlement can prevent a new
  // enable action, but it must never trap an already-enabled local master switch.
  toggle.disabled = busy || (explicitlyDenied && !toggle.checked);
  if (busy) toggle.title = '正在切换 GPTWork，请稍候 / Updating GPTWork…';
  else if (explicitlyDenied && !toggle.checked) toggle.title = '免费期或会员已到期，请在账户中心开通会员';
  else toggle.title = '启用或关闭 GPTWork；窗口数量不受限制';
}

async function refreshState() {
  const state = await runtimeMessage('GPTLOCK_GET_STATE');
  entitlement = {
    authenticated: Boolean(state?.account?.authenticated),
    active: Boolean(state?.account?.entitlement?.active),
  };
  const enabled = state?.settings?.enabled !== false;
  if (toggle) toggle.checked = enabled;
  const local = await withTimeout(storageGetLocalEnabled()).catch(() => null);
  if (local === null) await withTimeout(storageSetLocalEnabled(enabled)).catch(() => {});
  syncAvailability();
  return state;
}

async function persistEnabled(desired) {
  await withTimeout(storageSetLocalEnabled(desired));

  let syncQuotaFallback = false;
  try {
    await withTimeout(runtimeMessage({ type: 'GPTLOCK_SET_ENABLED', enabled: desired }));
  } catch (error) {
    if (!isSyncQuotaError(error)) throw error;
    syncQuotaFallback = true;
  }

  // In legacy background builds GPTLOCK_SET_ENABLED updates the in-memory state
  // before attempting chrome.storage.sync. If that sync write hits Chrome's
  // hourly quota, explicitly refresh the account/tabs so the new local state is
  // still applied immediately and the request monitor is attached/detached.
  await withTimeout(runtimeMessage({ type: 'GPTLOCK_ACCOUNT_REFRESH' })).catch((error) => {
    if (!syncQuotaFallback) throw error;
  });

  let confirmed = await withTimeout(runtimeMessage('GPTLOCK_GET_STATE'));
  if (Boolean(confirmed?.settings?.enabled) !== desired) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    confirmed = await withTimeout(runtimeMessage('GPTLOCK_GET_STATE'));
  }
  if (Boolean(confirmed?.settings?.enabled) !== desired) {
    throw new Error('设置未成功应用 / The setting was not applied');
  }
  return { syncQuotaFallback };
}

window.addEventListener('gptlock-entitlement-state', (event) => {
  entitlement = {
    authenticated: Boolean(event.detail?.authenticated),
    active: Boolean(event.detail?.active),
  };
  syncAvailability();
});

if (toggle) {
  toggle.addEventListener('change', (event) => {
    // Capture phase makes this controller the only owner of the switch action.
    // The legacy popup/options handlers are bypassed so the master switch remains
    // responsive even when chrome.storage.sync has exhausted its hourly quota.
    event.stopImmediatePropagation();
    if (busy) return;

    const desired = Boolean(toggle.checked);
    const previous = !desired;
    busy = true;
    syncAvailability();
    if (message) message.textContent = desired
      ? '正在启用请求锁定 / Enabling…'
      : '正在关闭 GPTWork / Disabling…';

    void persistEnabled(desired)
      .then(({ syncQuotaFallback }) => {
        toggle.checked = desired;
        if (message) message.textContent = desired
          ? `GPTWork 已启用 / Enabled.${syncQuotaFallback ? '（已使用本地状态，避开同步配额）' : ''}`
          : `GPTWork 已关闭 / Disabled.${syncQuotaFallback ? '（已使用本地状态，避开同步配额）' : ''}`;
      })
      .catch((error) => {
        toggle.checked = previous;
        void storageSetLocalEnabled(previous).catch(() => {});
        if (message) message.textContent = `切换失败 / Toggle failed: ${error.message}`;
      })
      .finally(() => {
        busy = false;
        syncAvailability();
        window.dispatchEvent(new CustomEvent('gptlock-account-refresh'));
        setTimeout(() => void refreshState().catch(() => {}), 250);
      });
  }, true);
}

void refreshState().catch(() => {
  // Fail open for the control itself when account state is temporarily unknown;
  // background.js still enforces entitlement through effectiveSettingsForState().
  entitlement = { authenticated: null, active: null };
  busy = false;
  syncAvailability();
});
