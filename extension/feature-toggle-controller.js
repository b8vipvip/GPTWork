const workToggle = document.getElementById('workModeEnabled');
const modelToggle = document.getElementById('modelLockEnabled');
const messageNode = document.getElementById('message') || document.getElementById('formMessage');
const scopeNode = document.getElementById('featureScope');
const STATE_TIMEOUT_MS = 5000;

let busy = false;
let currentTabId = null;
let currentAccount = { authenticated: false, entitlement: { active: false } };
let lastFeatureState = null;
let refreshTimers = [];

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

function withTimeout(promise, ms = STATE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(Object.assign(new Error('操作超时，请重试 / Operation timed out'), { code: 'STATE_TIMEOUT' })),
      ms,
    )),
  ]);
}

function showMessage(text, tone = '') {
  if (!messageNode) return;
  messageNode.textContent = text || '';
  messageNode.className = tone === 'bad' ? 'inline-message bad' : tone === 'good' ? 'inline-message good' : '';
}

function showQuotaMessage() {
  showMessage('当前账户并发窗口超限', 'bad');
}

function promptAuthentication(text = '请先登录或注册 GPTWork 后再启用此功能。') {
  showMessage(text, 'bad');
  window.dispatchEvent(new CustomEvent('gptlock-auth-required', { detail: { message: text } }));
}

function requireActivation(account = currentAccount) {
  if (!account?.authenticated) {
    promptAuthentication();
    throw Object.assign(new Error('请先登录或注册 GPTWork'), { code: 'AUTH_REQUIRED' });
  }
  if (!account?.entitlement?.active) {
    const text = '当前使用时长已到期，请签到、分享或升级后再启用此功能。';
    showMessage(text, 'bad');
    throw Object.assign(new Error(text), { code: 'ENTITLEMENT_REQUIRED' });
  }
}

function setBusy(value) {
  busy = Boolean(value);
  if (workToggle) workToggle.disabled = busy || !Number.isInteger(currentTabId);
  if (modelToggle) modelToggle.disabled = busy || !Number.isInteger(currentTabId);
}

function syncVisibleToggles(featureState) {
  if (!featureState) return;
  lastFeatureState = {
    workModeEnabled: featureState.workModeEnabled === true,
    modelLockEnabled: featureState.modelLockEnabled === true,
  };
  if (workToggle) workToggle.checked = lastFeatureState.workModeEnabled;
  if (modelToggle) modelToggle.checked = lastFeatureState.modelLockEnabled;
}

async function findChatGptTab() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  tabs.sort((left, right) => {
    if (Boolean(right.active) !== Boolean(left.active)) return Number(right.active) - Number(left.active);
    return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
  });
  return tabs.find((tab) => Number.isInteger(tab.id)) || null;
}

function renderScope(tab) {
  if (!scopeNode) return;
  if (!tab?.id) {
    scopeNode.textContent = '当前没有打开的 ChatGPT 标签页；Work 模式和模型锁定只会修改当前目标标签页。';
    return;
  }
  const title = String(tab.title || 'ChatGPT').replace(/\s+/g, ' ').trim().slice(0, 80);
  scopeNode.textContent = `当前标签页：${title}（Tab ${tab.id}）。Work 模式和模型锁定仅作用于此标签页，不会同步到其他窗口/标签。`;
}

async function reconcile() {
  const tab = await findChatGptTab();
  const nextTabId = Number.isInteger(tab?.id) ? tab.id : null;
  if (nextTabId !== currentTabId) lastFeatureState = null;
  currentTabId = nextTabId;
  renderScope(tab);
  if (!Number.isInteger(currentTabId)) {
    currentAccount = { authenticated: false, entitlement: { active: false } };
    syncVisibleToggles({ workModeEnabled: false, modelLockEnabled: false });
    setBusy(false);
    return null;
  }

  try {
    const snapshot = await withTimeout(runtimeMessage({ type: 'GPTWORK_TAB_FEATURE_GET', tabId: currentTabId }));
    currentAccount = snapshot?.account || currentAccount;
    syncVisibleToggles(snapshot?.featureState);
    setBusy(false);
    return snapshot;
  } catch (error) {
    // UI continuity only: the cached snapshot never becomes an authority and is never written
    // back. A transient transport timeout must not paint an enabled feature as disabled.
    if (lastFeatureState) syncVisibleToggles(lastFeatureState);
    showMessage('状态刷新暂时延迟，已保留当前功能配置 / State refresh delayed; keeping current feature state.', 'bad');
    setBusy(false);
    throw error;
  }
}

async function changeFeature(kind, desired) {
  if (busy || !Number.isInteger(currentTabId)) return;
  const target = kind === 'work' ? workToggle : modelToggle;
  const previous = !desired;
  setBusy(true);
  try {
    if (desired) requireActivation(currentAccount);
    const snapshot = await withTimeout(runtimeMessage({
      type: 'GPTWORK_TAB_FEATURE_SET',
      tabId: currentTabId,
      feature: kind,
      enabled: Boolean(desired),
    }));
    currentAccount = snapshot?.account || currentAccount;
    syncVisibleToggles(snapshot?.featureState);
    showMessage(desired
      ? `${kind === 'work' ? 'Work 模式' : '模型锁定'}已在当前标签页启用。`
      : `${kind === 'work' ? 'Work 模式' : '模型锁定'}已在当前标签页关闭。`, 'good');
  } catch (error) {
    if (target) target.checked = previous;
    if (lastFeatureState) syncVisibleToggles(lastFeatureState);
    if (error?.code === 'WINDOW_QUOTA_EXCEEDED' || error?.message === '当前账户并发窗口超限') {
      showQuotaMessage();
    } else if (!['AUTH_REQUIRED', 'ENTITLEMENT_REQUIRED'].includes(error?.code)) {
      showMessage(`切换失败 / Toggle failed: ${error.message}`, 'bad');
    }
    await reconcile().catch(() => {});
  } finally {
    setBusy(false);
  }
}

function bindFeatureToggle(toggle, kind) {
  if (!toggle) return;
  toggle.addEventListener('change', () => {
    void changeFeature(kind, Boolean(toggle.checked));
  });
}

function scheduleReconcile() {
  for (const timer of refreshTimers) clearTimeout(timer);
  refreshTimers = [0, 120, 450].map((delay) => setTimeout(() => void reconcile().catch(() => {}), delay));
}

bindFeatureToggle(workToggle, 'work');
bindFeatureToggle(modelToggle, 'model');

window.addEventListener('gptlock-account-changed', scheduleReconcile);
window.addEventListener('gptlock-account-refresh', scheduleReconcile);
window.addEventListener('focus', scheduleReconcile);
window.addEventListener('pageshow', scheduleReconcile);

chrome.tabs.onActivated?.addListener?.(() => scheduleReconcile());
chrome.tabs.onUpdated?.addListener?.((tabId, changeInfo) => {
  if (tabId === currentTabId && (changeInfo.status === 'complete' || changeInfo.url)) scheduleReconcile();
});

void reconcile().catch(() => {
  // reconcile() already preserves the last successful snapshot and renders a non-destructive warning.
});
