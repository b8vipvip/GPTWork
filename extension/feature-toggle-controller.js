import { runtimeMessage } from './extension-page-runtime.js';

const workToggle = document.getElementById('workModeEnabled');
const modelToggle = document.getElementById('modelLockEnabled');
const messageNode = document.getElementById('message') || document.getElementById('formMessage');
const scopeNode = document.getElementById('featureScope');
const STATE_TIMEOUT_MS = 5000;

let busy = false;
let currentTabId = null;
let currentAccount = { authenticated: false, entitlement: { active: false } };
let lastFeatureState = null;
let refreshTimer = null;
let reconcileGeneration = 0;

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

function showEntitlementRequired() {
  showMessage('当前使用时长已到期，请签到、分享或升级后再启用此功能。', 'bad');
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

function sortChatGptTabs(tabs) {
  return [...tabs].sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0));
}

async function findChatGptTab() {
  // Popup: bind to the active browser tab only when that tab is ChatGPT. Settings is
  // itself a browser tab, so it falls back to the most recently used ChatGPT tab. In
  // both cases the resulting feature state belongs to that exact tabId, never windowId.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (Number.isInteger(active?.id) && /^https:\/\/chatgpt\.com\//.test(String(active.url || ''))) return active;

  const sameWindowTabs = await chrome.tabs.query({ currentWindow: true, url: 'https://chatgpt.com/*' });
  const sameWindow = sortChatGptTabs(sameWindowTabs).find((tab) => Number.isInteger(tab.id));
  if (sameWindow) return sameWindow;

  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  return sortChatGptTabs(tabs).find((tab) => Number.isInteger(tab.id)) || null;
}

function renderScope(tab) {
  if (!scopeNode) return;
  if (!tab?.id) {
    scopeNode.textContent = '当前没有可用的 ChatGPT 标签页；Work 模式和模型锁定仅绑定具体 ChatGPT 标签页，不会按窗口共享。';
    return;
  }
  const title = String(tab.title || 'ChatGPT').replace(/\s+/g, ' ').trim().slice(0, 80);
  scopeNode.textContent = `当前标签页：${title}（Tab ${tab.id}）。Work 模式和模型锁定只对这个 ChatGPT 标签页生效，同一 Chrome 窗口中的其他 ChatGPT 标签页不会共享状态。`;
}

async function reconcile() {
  const generation = ++reconcileGeneration;
  const tab = await findChatGptTab();
  if (generation !== reconcileGeneration) return null;

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

  const targetTabId = currentTabId;
  try {
    const snapshot = await withTimeout(runtimeMessage({ type: 'GPTWORK_TAB_FEATURE_GET', tabId: targetTabId }));
    if (generation !== reconcileGeneration || targetTabId !== currentTabId) return snapshot;
    currentAccount = snapshot?.account || currentAccount;
    syncVisibleToggles(snapshot?.featureState);
    setBusy(false);
    return snapshot;
  } catch (error) {
    if (generation !== reconcileGeneration) return null;
    if (lastFeatureState) syncVisibleToggles(lastFeatureState);
    showMessage('状态刷新暂时延迟，已保留当前标签页功能配置 / State refresh delayed; keeping this tab state.', 'bad');
    setBusy(false);
    throw error;
  }
}

async function changeFeature(kind, desired) {
  if (busy || !Number.isInteger(currentTabId)) return;
  const target = kind === 'work' ? workToggle : modelToggle;
  const previous = !desired;
  const targetTabId = currentTabId;
  setBusy(true);
  try {
    // UI is not an authorization authority. The tab runtime validates the current
    // persisted account entitlement and the target tab's window quota before enabling.
    const snapshot = await withTimeout(runtimeMessage({
      type: 'GPTWORK_TAB_FEATURE_SET',
      tabId: targetTabId,
      feature: kind,
      enabled: Boolean(desired),
    }));
    currentAccount = snapshot?.account || currentAccount;
    syncVisibleToggles(snapshot?.featureState);
    showMessage(desired
      ? `${kind === 'work' ? 'Work 模式' : '模型锁定'}已在当前 ChatGPT 标签页启用；其他标签页不受影响。`
      : `${kind === 'work' ? 'Work 模式' : '模型锁定'}已在当前 ChatGPT 标签页关闭；其他标签页不受影响。`, 'good');
  } catch (error) {
    if (target) target.checked = previous;
    if (lastFeatureState) syncVisibleToggles(lastFeatureState);
    if (error?.code === 'WINDOW_QUOTA_EXCEEDED' || error?.message === '当前账户并发窗口超限') {
      showQuotaMessage();
    } else if (error?.code === 'AUTH_REQUIRED') {
      promptAuthentication();
    } else if (error?.code === 'ENTITLEMENT_REQUIRED') {
      const snapshot = await reconcile().catch(() => null);
      const account = snapshot?.account || currentAccount;
      if (account?.authenticated) showEntitlementRequired();
      else promptAuthentication();
    } else {
      showMessage(`切换失败 / Toggle failed: ${error.message}`, 'bad');
    }
    if (!['ENTITLEMENT_REQUIRED'].includes(error?.code)) await reconcile().catch(() => {});
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
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void reconcile().catch(() => {});
  }, 120);
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
  // reconcile() already preserves the last successful tab snapshot and renders a warning.
});
