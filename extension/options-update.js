import { runtimeMessage } from './extension-page-runtime.js';
import { RELEASES_URL, UPDATE_STATUS_KEY } from './update-manager.js';

const TRANSIENT_PHASES = new Set([
  'checking',
  'downloading',
  'verifying',
  'quiescing',
  'installing',
  'reloading',
  'recovering',
]);

const el = {
  card: document.getElementById('updates'),
  badge: document.getElementById('updateStatusBadge'),
  current: document.getElementById('updateCurrentVersion'),
  latest: document.getElementById('updateLatestVersion'),
  core: document.getElementById('updateCoreVersion'),
  progress: document.getElementById('updateProgress'),
  percent: document.getElementById('updatePercent'),
  message: document.getElementById('updateMessage'),
  log: document.getElementById('updateLog'),
  check: document.getElementById('checkUpdateNow'),
  install: document.getElementById('installUpdateNow'),
  release: document.getElementById('openRelease'),
};

let status = null;
let release = null;
let state = null;
let busy = false;
let logLines = [];

function phaseLabel(phase) {
  return ({
    idle: '待检查',
    checking: '检查中',
    ready: '发现新版',
    downloading: '下载中',
    verifying: '校验中',
    quiescing: '安全停止中',
    installing: '安装中',
    reloading: '重载中',
    recovering: '恢复功能中',
    complete: '全部就绪',
    up_to_date: '已是最新',
    managed_disabled: '自动更新已停用',
    error: '未完成',
  })[phase] || '更新状态';
}

function phaseTone(phase) {
  if (phase === 'error') return 'bad';
  if (phase === 'complete' || phase === 'up_to_date') return 'good';
  if (TRANSIENT_PHASES.has(phase)) return 'running';
  if (phase === 'ready') return 'ready';
  return 'idle';
}

function appendLog(message) {
  if (!message) return;
  const stamp = new Date().toLocaleTimeString();
  logLines.push(`${stamp}  ${message}`);
  if (logLines.length > 14) logLines = logLines.slice(-14);
  if (el.log) {
    el.log.textContent = logLines.join('\n') || '等待更新操作…';
    el.log.scrollTop = el.log.scrollHeight;
  }
}

function setBusy(value) {
  busy = Boolean(value);
  if (el.check) el.check.disabled = busy || TRANSIENT_PHASES.has(status?.phase);
  if (el.install) el.install.disabled = busy || TRANSIENT_PHASES.has(status?.phase);
}

function readinessDetail(value) {
  const readiness = value?.readiness;
  if (!readiness) return '';
  const runtime = readiness.runtime || {};
  const content = readiness.content || {};
  const core = runtime.core?.required === false
    ? 'Core 无需连接'
    : runtime.core?.connected
      ? 'Core 已连接'
      : 'Core 未连接';
  const pages = `页面运行时 ${content.ready || 0}/${content.total || 0}`;
  const monitor = `请求锁定器 ${runtime.tabs?.monitorAttached || 0}/${runtime.tabs?.monitorRequired || 0}`;
  return `${core} · ${pages} · ${monitor}`;
}

function renderStatus(next = status) {
  if (!next) return;
  status = next;
  const percent = Math.max(0, Math.min(100, Math.round(Number(next.percent) || 0)));
  if (el.progress) el.progress.style.width = `${percent}%`;
  if (el.percent) el.percent.textContent = `${percent}%`;
  if (el.message) {
    const detail = readinessDetail(next);
    el.message.textContent = [next.message || '等待更新操作…', detail].filter(Boolean).join(' · ');
  }
  if (el.badge) {
    el.badge.textContent = phaseLabel(next.phase);
    el.badge.className = `update-badge ${phaseTone(next.phase)}`;
  }
  if (el.latest && next.targetVersion) el.latest.textContent = next.targetVersion;
  if (el.core) {
    if (next.nativeVersion) el.core.textContent = next.nativeVersion;
    else if (state?.nativeStatus?.version) el.core.textContent = state.nativeStatus.version;
    else if (state?.nativeStatus?.connected) el.core.textContent = '已连接';
    else el.core.textContent = '离线';
  }
  if (el.install) {
    el.install.hidden = next.phase !== 'ready';
    el.install.textContent = next.autoInstallReady === false ? '查看升级方式' : '立即更新';
  }
  setBusy(busy);
}

async function loadState() {
  state = await runtimeMessage({ type: 'GPTLOCK_GET_STATE' });
  const currentVersion = state?.extensionVersion || chrome.runtime.getManifest().version;
  if (el.current) el.current.textContent = currentVersion;
  if (el.core) {
    el.core.textContent = state?.nativeStatus?.version
      || (state?.nativeStatus?.connected ? '已连接' : '离线');
  }
  return state;
}

async function loadUpdateStatus() {
  const result = await runtimeMessage({ type: 'GPTWORK_UPDATE_STATUS_GET' });
  status = result?.status || status || {
    phase: 'idle',
    percent: 0,
    message: '尚未检查更新',
    targetVersion: null,
  };
  if (el.current) el.current.textContent = result?.currentVersion || chrome.runtime.getManifest().version;
  renderStatus(status);
  return status;
}

async function checkNow() {
  if (busy || TRANSIENT_PHASES.has(status?.phase)) return;
  setBusy(true);
  appendLog('开始检查正式版本');
  try {
    const result = await runtimeMessage({ type: 'GPTWORK_UPDATE_CHECK' });
    release = result?.release || null;
    renderStatus(result?.status || status);
    appendLog(result?.status?.message || '版本检查完成');
  } catch (error) {
    appendLog(`检查失败 · ${error.message}`);
    await loadUpdateStatus().catch(() => {});
  } finally {
    setBusy(false);
  }
}

async function installNow() {
  if (busy || TRANSIENT_PHASES.has(status?.phase)) return;
  if (status?.autoInstallReady === false) {
    await chrome.tabs.create({ url: release?.releaseUrl || RELEASES_URL });
    return;
  }
  setBusy(true);
  appendLog(`开始安装 ${status?.targetVersion || '新版本'}；后续由后台更新协调器接管`);
  try {
    // The service worker is the sole update authority. It may intentionally reload the
    // extension before this request gets a final response; progress is persisted and the
    // replacement settings page will resume from GPTWORK_UPDATE_STATUS_GET.
    await runtimeMessage({ type: 'GPTWORK_UPDATE_INSTALL' });
  } catch (error) {
    if (!/context invalidated|message port closed|receiving end/i.test(String(error?.message || ''))) {
      appendLog(`安装请求返回 · ${error.message}`);
    }
  } finally {
    await loadUpdateStatus().catch(() => {});
    setBusy(false);
  }
}

el.check?.addEventListener('click', () => { void checkNow(); });
el.install?.addEventListener('click', () => { void installNow(); });
el.release?.addEventListener('click', () => {
  void chrome.tabs.create({ url: release?.releaseUrl || RELEASES_URL });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[UPDATE_STATUS_KEY]?.newValue) {
    const previousPhase = status?.phase;
    renderStatus(changes[UPDATE_STATUS_KEY].newValue);
    if (status?.phase !== previousPhase) appendLog(status?.message || phaseLabel(status?.phase));
  }
  if (changes.nativeStatus?.newValue) {
    state = { ...(state || {}), nativeStatus: changes.nativeStatus.newValue };
    if (el.core) {
      el.core.textContent = changes.nativeStatus.newValue?.version
        || (changes.nativeStatus.newValue?.connected ? '已连接' : '离线');
    }
  }
});

window.addEventListener('focus', () => {
  void Promise.allSettled([loadState(), loadUpdateStatus()]);
});
window.addEventListener('pageshow', () => {
  void Promise.allSettled([loadState(), loadUpdateStatus()]);
});

void Promise.all([loadState(), loadUpdateStatus()]).catch((error) => {
  appendLog(`更新中心初始化失败 · ${error.message}`);
  if (el.message) el.message.textContent = `更新中心初始化失败：${error.message}`;
});
