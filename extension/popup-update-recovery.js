import { contentRuntimeReady } from './content-runtime-recovery.js';
import { compareVersions } from './update-manager.js';

const UPDATE_STATUS_KEY = 'gptlockUiUpdateStatus';
const RECOVERY_TIMEOUT_MARKER = '更新已安装但功能恢复超时';
const GUIDE_ID = 'updateRecoveryGuide';

function recoverySnapshot(status) {
  const detail = String(status?.error || status?.message || '');
  if (!detail.includes(RECOVERY_TIMEOUT_MARKER)) return null;
  const jsonStart = detail.indexOf('{');
  if (jsonStart < 0) return {};
  try { return JSON.parse(detail.slice(jsonStart)); } catch { return {}; }
}

function managerAddress() {
  return `chrome://extensions/?id=${chrome.runtime.id}`;
}

async function liveRecoveryReadiness(status, snapshot) {
  const currentVersion = chrome.runtime.getManifest().version;
  const targetVersion = String(status?.targetVersion || '');
  if (!targetVersion || compareVersions(currentVersion, targetVersion) < 0) return { ready: false };

  const stored = await chrome.storage.local.get(['nativeStatus', 'gptworkEnabledLocal']);
  const nativeStatus = stored?.nativeStatus || {};
  const coreReady = nativeStatus.connected === true && compareVersions(nativeStatus.version, targetVersion) >= 0;
  if (!coreReady) return { ready: false, coreReady, nativeVersion: nativeStatus.version ?? null };

  // If GPTWork was enabled before the update, recovery is not complete while the master
  // gate is still off. This prevents a stale Core version alone from falsely clearing UI.
  if (status?.originalMasterEnabled === true && stored?.gptworkEnabledLocal !== true) {
    return { ready: false, coreReady, nativeVersion: nativeStatus.version ?? null };
  }

  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' }).catch(() => []);
  const liveTabIds = new Set(tabs.filter((tab) => Number.isInteger(tab?.id)).map((tab) => tab.id));
  const contentCandidates = tabs.filter((tab) => Number.isInteger(tab?.id) && tab.status !== 'loading');
  const pendingContentTabs = [];
  for (const tab of contentCandidates) {
    if (!await contentRuntimeReady(tab.id)) pendingContentTabs.push(tab.id);
  }

  const expectedMonitorTabs = Array.isArray(snapshot?.expectedMonitorTabs)
    ? snapshot.expectedMonitorTabs.filter((tabId) => liveTabIds.has(tabId))
    : [];
  let pendingMonitorTabs = [];
  if (expectedMonitorTabs.length && chrome.debugger?.getTargets) {
    const targets = await chrome.debugger.getTargets().catch(() => []);
    const attached = new Set(targets
      .filter((target) => target?.attached === true && Number.isInteger(target?.tabId))
      .map((target) => target.tabId));
    pendingMonitorTabs = expectedMonitorTabs.filter((tabId) => !attached.has(tabId));
  }

  return {
    ready: pendingContentTabs.length === 0 && pendingMonitorTabs.length === 0,
    coreReady,
    nativeVersion: nativeStatus.version ?? null,
    pendingContentTabs,
    pendingMonitorTabs,
  };
}

async function reconcileStaleRecoveryStatus(status) {
  const snapshot = recoverySnapshot(status);
  if (!snapshot || status?.phase !== 'error') return status;
  const readiness = await liveRecoveryReadiness(status, snapshot);
  if (!readiness.ready) return status;

  const next = {
    ...status,
    schemaVersion: 3,
    phase: 'complete',
    percent: 100,
    nativeVersion: readiness.nativeVersion,
    message: `更新完成：${status.targetVersion}。本地核心、页面运行时和请求锁定器已恢复。`,
    error: null,
    failedAt: null,
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [UPDATE_STATUS_KEY]: next });
  return next;
}

async function copyManagerAddress(button, address, detail) {
  try {
    await navigator.clipboard.writeText(address);
    button.textContent = '已复制扩展管理地址 / Copied';
    detail.textContent = `已复制 ${address}。粘贴到浏览器地址栏打开后，找到 GPTWork 并点击“重新加载”。`;
  } catch {
    detail.textContent = `浏览器未允许自动复制。请手动复制 ${address} 到地址栏，找到 GPTWork 后点击“重新加载”。`;
  }
}

function ensureGuide(card) {
  let guide = document.getElementById(GUIDE_ID);
  if (guide) return guide;
  guide = document.createElement('div');
  guide.id = GUIDE_ID;
  guide.className = 'update-recovery-guide';
  guide.hidden = true;
  const title = document.createElement('strong');
  title.className = 'update-recovery-guide-title';
  const detail = document.createElement('p');
  detail.className = 'update-recovery-guide-detail';
  const automatic = document.createElement('button');
  automatic.type = 'button';
  automatic.className = 'update-recovery-primary';
  automatic.textContent = '再次自动重新加载 GPTWork / Reload GPTWork';
  automatic.addEventListener('click', () => {
    automatic.disabled = true;
    detail.textContent = '正在重新加载 GPTWork。弹窗会自动关闭；稍后重新打开即可检查恢复状态。';
    setTimeout(() => chrome.runtime.reload(), 80);
  });
  const manual = document.createElement('button');
  manual.type = 'button';
  manual.className = 'update-recovery-secondary';
  manual.textContent = '复制扩展管理地址 / Copy extensions page';
  manual.addEventListener('click', () => { void copyManagerAddress(manual, managerAddress(), detail); });
  const address = document.createElement('code');
  address.className = 'update-recovery-address';
  address.textContent = managerAddress();
  guide.append(title, detail, automatic, manual, address);
  card.append(guide);
  return guide;
}

function renderRecoveryGuide(status) {
  const card = document.getElementById('updateRuntimeProgress');
  if (!card) return;
  const guide = ensureGuide(card);
  const snapshot = recoverySnapshot(status);
  if (!snapshot || status?.phase !== 'error') { guide.hidden = true; return; }

  guide.hidden = false;
  const title = guide.querySelector('.update-recovery-guide-title');
  const detail = guide.querySelector('.update-recovery-guide-detail');
  const automatic = guide.querySelector('.update-recovery-primary');
  const address = guide.querySelector('.update-recovery-address');
  if (automatic) automatic.disabled = false;
  if (address) address.textContent = managerAddress();
  const currentVersion = chrome.runtime.getManifest().version;
  const targetVersion = String(status?.targetVersion || currentVersion);
  const nativeVersion = snapshot?.nativeVersion ? String(snapshot.nativeVersion) : null;
  const pendingContent = Array.isArray(snapshot?.pendingContentTabs) ? snapshot.pendingContentTabs.length : 0;
  const pendingMonitor = Array.isArray(snapshot?.pendingMonitorTabs) ? snapshot.pendingMonitorTabs.length : 0;
  if (title) title.textContent = '更新已安装，需要最后一步 / Recovery action required';
  if (!detail) return;
  if (snapshot?.coreReady === false) {
    detail.textContent = `扩展 ${currentVersion} 已加载，但恢复检查仍看到本地 Core ${nativeVersion || '未就绪'}（目标 ${targetVersion}）。先点“再次自动重新加载 GPTWork”；如果仍显示旧 Core，请重新运行正式安装器。仅在扩展管理页重新加载不能升级本地 Core。`;
    return;
  }
  const pendingText = pendingContent || pendingMonitor
    ? `仍有 ${pendingContent} 个页面运行时、${pendingMonitor} 个请求锁定器未恢复。`
    : '自动恢复没有在超时时间内完成。';
  detail.textContent = `${pendingText} 先点“再次自动重新加载 GPTWork”。若仍未恢复，请复制下方扩展管理地址到浏览器地址栏，在 GPTWork 卡片上点击“重新加载”，然后刷新 ChatGPT 页面。`;
}

async function loadRecoveryStatus() {
  try {
    const stored = await chrome.storage.local.get(UPDATE_STATUS_KEY);
    const current = stored?.[UPDATE_STATUS_KEY] || null;
    const reconciled = await reconcileStaleRecoveryStatus(current);
    renderRecoveryGuide(reconciled);
  } catch {
    // Recovery guidance is best effort and must not block the popup.
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes?.[UPDATE_STATUS_KEY]) return;
  const next = changes[UPDATE_STATUS_KEY].newValue || null;
  void reconcileStaleRecoveryStatus(next).then(renderRecoveryGuide).catch(() => renderRecoveryGuide(next));
});

void loadRecoveryStatus();
