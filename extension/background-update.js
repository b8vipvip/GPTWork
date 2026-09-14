import {
  compareVersions,
  fetchLatestRelease,
  supportsReliableWindowsOneClickUpdate,
  UPDATE_STATUS_KEY,
  WINDOWS_DOWNLOAD_FILENAME,
} from './update-manager.js';
import { appendRuntimeLog } from './runtime-log.js';
import { ACCOUNT_REFRESH_ALARM, scheduleAccountRefresh } from './account-refresh-scheduler.js';
import {
  contentRuntimeReady,
  recoverOpenTabs,
  resumeContentRecovery,
  suspendContentRecovery,
} from './content-runtime-recovery.js';
import { tabFeatureEnabledSync } from './tab-feature-runtime.js';

export const RELEASE_NOTIFICATION_URL = 'https://gptlock.mv3.cn/site/api/releases/notifications';
export const CLIENT_UPDATE_POLICY_URL = 'https://gptlock.mv3.cn/site/api/client-update/config';
export const CLIENT_CONTROL_URL = 'https://gptlock.mv3.cn/api/v1/client/control';
export const RELEASE_CHECK_ALARM = 'gptlock-release-check';
export const RELEASE_GENERATION_KEY = 'gptlockReleaseGeneration';
export const AUTO_UPDATE_ATTEMPT_KEY = 'gptlockAutoUpdateAttempt';
export const ADMIN_UPDATE_GENERATION_KEY = 'gptworkAdminUpdateGeneration';
export const ACCOUNT_SYNC_GENERATION_KEY = 'gptworkAccountSyncGeneration';
export const ACCOUNT_SESSION_KEY = 'gptlockAccountSessionToken';
export const AUTO_UPDATE_ALARM_MINUTES = 1;
export const NOTIFICATION_WAIT_MS = 20_000;
export const CLIENT_CONTROL_WAIT_MS = 20_000;
export const FAILED_RETRY_MS = 15 * 60 * 1000;

const NATIVE_HOST = 'com.gptlock.core';
const MASTER_KEY = 'gptworkEnabledLocal';
const NATIVE_STATUS_KEY = 'nativeStatus';
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 2 * 60 * 1000;
const INSTALL_INITIAL_WAIT_MS = 1_000;
const INSTALL_POLL_MS = 1_000;
const RECOVERY_TIMEOUT_MS = 45_000;
const NATIVE_TIMEOUT_MS = 12_000;
const LONG_POLL_ROUNDS = 3;
const TRANSIENT_PHASES = new Set([
  'downloading',
  'verifying',
  'quiescing',
  'installing',
  'reloading',
  'recovering',
]);

let updateTask = null;
let resumeTask = null;
let notificationTask = null;
let clientControlTask = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function logUpdate(level, event, details = {}) {
  if (!globalThis.chrome?.storage?.local) return;
  void appendRuntimeLog(level, 'update', event, details).catch(() => {});
}

export function releaseNotificationUrl(generation = '', waitMs = NOTIFICATION_WAIT_MS) {
  const url = new URL(RELEASE_NOTIFICATION_URL);
  if (generation) url.searchParams.set('since', String(generation));
  url.searchParams.set('wait', String(Math.max(0, Math.min(25_000, Number(waitMs) || 0))));
  return url.toString();
}

export function clientControlUrl({ sinceUpdate = 0, sinceAccount = 0, waitMs = CLIENT_CONTROL_WAIT_MS } = {}) {
  const url = new URL(CLIENT_CONTROL_URL);
  url.searchParams.set('sinceUpdate', String(Math.max(0, Number(sinceUpdate) || 0)));
  url.searchParams.set('sinceAccount', String(Math.max(0, Number(sinceAccount) || 0)));
  url.searchParams.set('wait', String(Math.max(0, Math.min(25_000, Number(waitMs) || 0))));
  return url.toString();
}

export function shouldAutoInstall({ platformOs, nativeConnected, nativeVersion }) {
  return platformOs === 'win'
    && Boolean(nativeConnected)
    && supportsReliableWindowsOneClickUpdate(nativeVersion);
}

function getPlatformInfo(chromeApi = globalThis.chrome) {
  return new Promise((resolve) => chromeApi.runtime.getPlatformInfo((info) => resolve(info ?? {})));
}

function nativeRequest(type, payload = {}, chromeApi = globalThis.chrome, timeoutMs = NATIVE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = `background-update-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let port;
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error(`Native request timed out: ${type}`)), timeoutMs);

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch {}
      callback(value);
    }

    try {
      port = chromeApi.runtime.connectNative(NATIVE_HOST);
      port.onMessage.addListener((response) => {
        if (String(response?.id) !== id) return;
        if (response?.ok) finish(resolve, response.data);
        else finish(reject, new Error(response?.error?.messageZhCn || response?.error?.messageEn || 'Native request failed'));
      });
      port.onDisconnect.addListener(() => {
        if (!settled) finish(reject, new Error(chromeApi.runtime.lastError?.message || 'Native host disconnected'));
      });
      port.postMessage({ id, type, ...payload });
    } catch (error) {
      finish(reject, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function downloadFile(options, chromeApi = globalThis.chrome) {
  return new Promise((resolve, reject) => {
    chromeApi.downloads.download(options, (downloadId) => {
      const error = chromeApi.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!Number.isInteger(downloadId)) reject(new Error('浏览器未启动安装器下载 / Browser did not start installer download'));
      else resolve(downloadId);
    });
  });
}

function findDownload(downloadId, chromeApi = globalThis.chrome) {
  return new Promise((resolve, reject) => {
    chromeApi.downloads.search({ id: downloadId }, (items) => {
      const error = chromeApi.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(items?.[0] ?? null);
    });
  });
}

async function getUpdateStatus(chromeApi = globalThis.chrome) {
  const stored = await chromeApi.storage.local.get(UPDATE_STATUS_KEY);
  return stored?.[UPDATE_STATUS_KEY] && typeof stored[UPDATE_STATUS_KEY] === 'object'
    ? stored[UPDATE_STATUS_KEY]
    : null;
}

async function setUpdateStatus(status, chromeApi = globalThis.chrome) {
  const previous = await getUpdateStatus(chromeApi);
  const next = {
    ...(previous || {}),
    schemaVersion: 3,
    ...status,
    updatedAt: new Date().toISOString(),
  };
  await chromeApi.storage.local.set({ [UPDATE_STATUS_KEY]: next });
  return next;
}

async function setActionUpdateState({ available, version, installing = false, error = false }, chromeApi = globalThis.chrome) {
  if (!chromeApi.action) return;
  if (!available) {
    await chromeApi.action.setBadgeText({ text: '' }).catch(() => {});
    await chromeApi.action.setTitle({ title: 'GPTWork' }).catch(() => {});
    return;
  }
  const badge = error ? 'ERR' : installing ? 'UPD' : 'NEW';
  const title = error
    ? `GPTWork ${version || ''} 更新失败，点击查看`
    : installing
      ? `GPTWork 正在更新到 ${version || '新版本'}`
      : `GPTWork ${version || '新版本'} 已发布`;
  await chromeApi.action.setBadgeText({ text: badge }).catch(() => {});
  await chromeApi.action.setTitle({ title }).catch(() => {});
}

async function waitForDownload(downloadId, targetVersion, chromeApi = globalThis.chrome) {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  let lastPercent = -1;
  while (Date.now() < deadline) {
    const item = await findDownload(downloadId, chromeApi);
    if (item?.state === 'complete') {
      if (item.danger && !['safe', 'accepted'].includes(item.danger)) {
        throw new Error(`浏览器安全检查阻止安装器：${item.danger}`);
      }
      if (!item.filename) throw new Error('无法取得下载后的安装器路径');
      await setUpdateStatus({
        phase: 'downloading', percent: 50, targetVersion, downloadId,
        message: `安装包下载完成：${targetVersion}`,
      }, chromeApi);
      return item;
    }
    if (item?.state === 'interrupted') throw new Error(`安装器下载中断：${item.error || 'unknown'}`);
    let percent = 18;
    if (Number(item?.totalBytes) > 0) {
      percent = 15 + Math.round(Math.max(0, Math.min(1, Number(item.bytesReceived || 0) / Number(item.totalBytes))) * 34);
    }
    if (percent !== lastPercent) {
      lastPercent = percent;
      await setUpdateStatus({
        phase: 'downloading', percent, targetVersion, downloadId,
        message: `正在下载 ${targetVersion} 安装包… ${percent}%`,
      }, chromeApi);
    }
    await sleep(350);
  }
  throw new Error('安装器下载超时');
}

async function waitForInstalledCore(targetVersion, chromeApi = globalThis.chrome) {
  await sleep(INSTALL_INITIAL_WAIT_MS);
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  let lastVersion = null;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const status = await nativeRequest('get_status', {}, chromeApi, 5_000);
      lastVersion = status?.version || lastVersion;
      if (compareVersions(status?.version, targetVersion) >= 0) return status;
    } catch {
      // During Setup the Native Messaging manifests are deliberately unavailable.
    }
    if (attempt % 3 === 0) {
      const elapsed = Date.now() - (deadline - INSTALL_TIMEOUT_MS);
      const percent = 72 + Math.min(8, Math.floor((elapsed / INSTALL_TIMEOUT_MS) * 8));
      await setUpdateStatus({
        phase: 'installing', percent, targetVersion,
        message: `安装器正在替换组件，等待新 Core ${targetVersion} 启动…`,
      }, chromeApi).catch(() => {});
    }
    await sleep(INSTALL_POLL_MS);
  }
  throw new Error(`等待新版本 Core 启动超时${lastVersion ? `，最后版本 ${lastVersion}` : ''}`);
}

async function recentFailedAttempt(version, chromeApi = globalThis.chrome) {
  const stored = await chromeApi.storage.local.get(AUTO_UPDATE_ATTEMPT_KEY);
  const attempt = stored[AUTO_UPDATE_ATTEMPT_KEY];
  if (attempt?.version !== version || attempt?.outcome !== 'failed') return false;
  const failedAt = Date.parse(attempt.at || '');
  return Number.isFinite(failedAt) && Date.now() - failedAt < FAILED_RETRY_MS;
}

async function recordAttempt(version, outcome, details = {}, chromeApi = globalThis.chrome) {
  await chromeApi.storage.local.set({
    [AUTO_UPDATE_ATTEMPT_KEY]: {
      version,
      outcome,
      at: new Date().toISOString(),
      ...details,
    },
  });
}

export async function fetchManagedUpdatePolicy(fetchImpl = fetch) {
  const response = await fetchImpl(CLIENT_UPDATE_POLICY_URL, {
    cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`client update policy service failed (${response.status})`);
  const payload = await response.json();
  return {
    enabled: payload?.autoUpdateEnabled !== false,
    syncGeneration: Number(payload?.syncGeneration || 0),
    updatedAt: payload?.updatedAt || null,
  };
}

function sendTabMessage(tabId, message, chromeApi = globalThis.chrome) {
  return new Promise((resolve) => {
    try {
      chromeApi.tabs.sendMessage(tabId, message, (response) => {
        void chromeApi.runtime.lastError;
        resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function quiesceForUpdate(targetVersion, chromeApi = globalThis.chrome) {
  const stored = await chromeApi.storage.local.get(MASTER_KEY);
  const previousStatus = await getUpdateStatus(chromeApi);
  const originalMasterEnabled = typeof previousStatus?.originalMasterEnabled === 'boolean'
    ? previousStatus.originalMasterEnabled
    : stored?.[MASTER_KEY] === true;

  suspendContentRecovery('update_quiescing');
  await setUpdateStatus({
    phase: 'quiescing', percent: 62, targetVersion,
    originalMasterEnabled,
    message: '正在安全停止旧版页面运行时、请求锁定器和本地核心…',
  }, chromeApi);

  let tabs = [];
  try { tabs = await chromeApi.tabs.query({ url: 'https://chatgpt.com/*' }); } catch {}
  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id)) continue;
    await sendTabMessage(tab.id, { type: 'GPTWORK_CONTENT_PREPARE_RELOAD' }, chromeApi);
    await sleep(25);
  }

  // The canonical Master key is the one normal background lifecycle gate. Temporarily
  // switch it off rather than duplicating debugger/native cleanup inside the updater.
  // background.js remains the sole owner that actually detaches and disconnects.
  if (stored?.[MASTER_KEY] === true) await chromeApi.storage.local.set({ [MASTER_KEY]: false });
  await sleep(500);
  logUpdate('info', 'update_runtime_quiesced', { targetVersion, originalMasterEnabled, tabCount: tabs.length });
  return originalMasterEnabled;
}

async function restoreAfterFailedUpdate(chromeApi = globalThis.chrome) {
  const status = await getUpdateStatus(chromeApi);
  resumeContentRecovery();
  if (status?.originalMasterEnabled === true) {
    await chromeApi.storage.local.set({ [MASTER_KEY]: true }).catch(() => {});
  }
}

async function debuggerAttachedTabIds(chromeApi = globalThis.chrome) {
  if (!chromeApi.debugger?.getTargets) return new Set();
  try {
    const targets = await chromeApi.debugger.getTargets();
    return new Set(targets.filter((target) => target?.attached === true && Number.isInteger(target.tabId)).map((target) => target.tabId));
  } catch {
    return new Set();
  }
}

async function runtimeReadiness(targetVersion, chromeApi = globalThis.chrome) {
  const tabs = await chromeApi.tabs.query({ url: 'https://chatgpt.com/*' }).catch(() => []);
  const readyTabs = [];
  const pendingContentTabs = [];
  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id) || tab.status === 'loading') continue;
    if (await contentRuntimeReady(tab.id)) readyTabs.push(tab.id);
    else pendingContentTabs.push(tab.id);
  }

  const attached = await debuggerAttachedTabIds(chromeApi);
  const expectedMonitorTabs = tabs
    .filter((tab) => Number.isInteger(tab?.id) && tabFeatureEnabledSync(tab.id))
    .map((tab) => tab.id);
  const pendingMonitorTabs = expectedMonitorTabs.filter((tabId) => !attached.has(tabId));
  const stored = await chromeApi.storage.local.get(NATIVE_STATUS_KEY);
  const nativeStatus = stored?.[NATIVE_STATUS_KEY] || null;
  const coreReady = nativeStatus?.connected === true
    && compareVersions(nativeStatus?.version, targetVersion) >= 0;

  return {
    ready: coreReady && pendingContentTabs.length === 0 && pendingMonitorTabs.length === 0,
    coreReady,
    nativeVersion: nativeStatus?.version ?? null,
    tabCount: tabs.length,
    readyContentCount: readyTabs.length,
    pendingContentTabs,
    expectedMonitorTabs,
    pendingMonitorTabs,
  };
}

async function recoverAfterReload(status, chromeApi = globalThis.chrome) {
  const targetVersion = status?.targetVersion;
  if (!targetVersion) throw new Error('更新恢复缺少目标版本');
  const currentVersion = chromeApi.runtime.getManifest().version;
  if (compareVersions(currentVersion, targetVersion) < 0) {
    const reloadAttempts = Math.max(0, Number(status?.reloadAttempts || 0));
    if (reloadAttempts >= 1) {
      throw new Error(`扩展仍为 ${currentVersion}，未切换到 ${targetVersion}`);
    }
    await waitForInstalledCore(targetVersion, chromeApi);
    await setUpdateStatus({
      phase: 'reloading', percent: 83, targetVersion,
      reloadAttempts: reloadAttempts + 1,
      message: `新组件已安装，正在加载扩展 ${targetVersion}…`,
    }, chromeApi);
    await sleep(300);
    chromeApi.runtime.reload();
    return { reloadRequested: true };
  }

  await setUpdateStatus({
    phase: 'recovering', percent: 86, targetVersion,
    message: '新版扩展已加载，正在恢复本地核心和页面功能…',
  }, chromeApi);

  resumeContentRecovery();
  if (status?.originalMasterEnabled === true) {
    await chromeApi.storage.local.set({ [MASTER_KEY]: true });
  }

  if (status?.originalMasterEnabled !== true) {
    await recordAttempt(targetVersion, 'complete', { nativeVersion: null }, chromeApi);
    await setUpdateStatus({
      phase: 'complete', percent: 100, targetVersion,
      message: `更新完成：${targetVersion}。GPTWork 总开关保持关闭。`,
      completedAt: new Date().toISOString(),
    }, chromeApi);
    await setActionUpdateState({ available: false }, chromeApi);
    return { complete: true, masterEnabled: false };
  }

  await recoverOpenTabs('update_recovery', {
    onProgress: async (progress) => {
      const ratio = progress.total > 0 ? progress.ready / progress.total : 1;
      await setUpdateStatus({
        phase: 'recovering', percent: 88 + Math.round(ratio * 5), targetVersion,
        message: `正在恢复 ChatGPT 页面运行时 ${progress.ready}/${progress.total}…`,
      }, chromeApi);
    },
  });

  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await runtimeReadiness(targetVersion, chromeApi);
    if (last.ready) {
      await recordAttempt(targetVersion, 'complete', { nativeVersion: last.nativeVersion }, chromeApi);
      await setUpdateStatus({
        phase: 'complete', percent: 100, targetVersion,
        nativeVersion: last.nativeVersion,
        message: `更新完成：${targetVersion}。本地核心、页面运行时和请求锁定器均已恢复。`,
        completedAt: new Date().toISOString(),
      }, chromeApi);
      await setActionUpdateState({ available: false }, chromeApi);
      logUpdate('info', 'background_auto_update_completed', { targetVersion, ...last });
      return { complete: true, ...last };
    }
    const pending = last.pendingContentTabs.length + last.pendingMonitorTabs.length;
    const percent = last.coreReady ? (pending > 0 ? 97 : 99) : 95;
    const detail = !last.coreReady
      ? '等待本地核心连接'
      : last.pendingContentTabs.length
        ? `等待 ${last.pendingContentTabs.length} 个页面运行时`
        : `等待 ${last.pendingMonitorTabs.length} 个请求锁定器`;
    await setUpdateStatus({
      phase: 'recovering', percent, targetVersion,
      nativeVersion: last.nativeVersion,
      message: `更新已安装，正在完成恢复：${detail}…`,
    }, chromeApi);
    await sleep(750);
  }
  throw new Error(`更新已安装但功能恢复超时：${JSON.stringify(last || {})}`);
}

async function resumeInterruptedUpdate(chromeApi = globalThis.chrome) {
  if (resumeTask) return resumeTask;
  resumeTask = (async () => {
    const status = await getUpdateStatus(chromeApi);
    if (!TRANSIENT_PHASES.has(status?.phase)) return false;

    // A worker may restart while the silent installer is still running. The persistent
    // Master=OFF transaction gate prevents normal background initialization from
    // reconnecting the Core. Wait for the target Core, then perform exactly one reload.
    if (status.phase === 'installing') {
      await waitForInstalledCore(status.targetVersion, chromeApi);
      await setUpdateStatus({
        phase: 'reloading', percent: 82, targetVersion: status.targetVersion,
        reloadAttempts: 0,
        message: `组件 ${status.targetVersion} 已安装，正在重新加载扩展…`,
      }, chromeApi);
      await sleep(300);
      chromeApi.runtime.reload();
      return true;
    }

    if (status.phase === 'reloading' || status.phase === 'recovering') {
      await recoverAfterReload(status, chromeApi);
      return true;
    }

    // Download/verify/quiesce cannot safely be resumed after the owning worker vanished:
    // no installer completion is known. Restore the user's Master state and surface one
    // explicit failure rather than starting a second overlapping update transaction.
    await restoreAfterFailedUpdate(chromeApi);
    await setUpdateStatus({
      phase: 'error', percent: Math.max(0, Number(status.percent || 0)),
      targetVersion: status.targetVersion ?? null,
      message: '更新事务在安装器启动前被中断，请重新执行更新。',
      error: 'update_transaction_interrupted_before_install',
      failedAt: new Date().toISOString(),
    }, chromeApi);
    return true;
  })().catch(async (error) => {
    await restoreAfterFailedUpdate(chromeApi).catch(() => {});
    const status = await getUpdateStatus(chromeApi).catch(() => null);
    await setUpdateStatus({
      phase: 'error', percent: Math.min(99, Math.max(0, Number(status?.percent || 0))),
      targetVersion: status?.targetVersion ?? null,
      message: `更新恢复失败：${errorText(error)}`,
      error: errorText(error),
      failedAt: new Date().toISOString(),
    }, chromeApi).catch(() => {});
    await setActionUpdateState({ available: true, version: status?.targetVersion, error: true }, chromeApi).catch(() => {});
    logUpdate('error', 'update_resume_failed', { error: errorText(error), targetVersion: status?.targetVersion ?? null });
    return true;
  }).finally(() => { resumeTask = null; });
  return resumeTask;
}

async function autoInstallWindows(release, nativeStatus, chromeApi = globalThis.chrome) {
  const targetVersion = release.latestVersion;
  await recordAttempt(targetVersion, 'running', {}, chromeApi);
  await setActionUpdateState({ available: true, version: targetVersion, installing: true }, chromeApi);
  await setUpdateStatus({
    phase: 'downloading', percent: 15,
    targetVersion,
    nativeVersion: nativeStatus?.version ?? null,
    originalMasterEnabled: undefined,
    reloadAttempts: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    message: `服务端已发布 ${targetVersion}，正在下载安装包…`,
  }, chromeApi);

  logUpdate('info', 'background_auto_update_started', {
    currentVersion: release.currentVersion,
    targetVersion,
    source: 'server_mirror',
  });

  const downloadId = await downloadFile({
    url: release.installer.url,
    filename: WINDOWS_DOWNLOAD_FILENAME,
    conflictAction: 'overwrite',
    saveAs: false,
  }, chromeApi);
  const download = await waitForDownload(downloadId, targetVersion, chromeApi);

  await setUpdateStatus({
    phase: 'verifying', percent: 55,
    targetVersion,
    nativeVersion: nativeStatus?.version ?? null,
    message: '安装包下载完成，正在准备安全更新事务…',
    downloadId,
  }, chromeApi);

  const originalMasterEnabled = await quiesceForUpdate(targetVersion, chromeApi);
  const prepared = await nativeRequest('prepare_update', {
    update: {
      installerPath: download.filename,
      expectedSha256: release.installer.sha256,
      targetVersion,
    },
  }, chromeApi);

  await setUpdateStatus({
    phase: 'installing', percent: 70,
    targetVersion,
    nativeVersion: nativeStatus?.version ?? null,
    originalMasterEnabled,
    message: `正在后台安装 ${targetVersion}；浏览器保持打开，GPTWork 功能暂时停用…`,
    launcherStrategy: prepared?.launcherStrategy ?? null,
    launcherProcessId: prepared?.launcherProcessId ?? null,
  }, chromeApi);

  const installed = await waitForInstalledCore(targetVersion, chromeApi);
  await setUpdateStatus({
    phase: 'reloading', percent: 82,
    targetVersion,
    nativeVersion: installed?.version ?? targetVersion,
    originalMasterEnabled,
    reloadAttempts: 0,
    message: `新组件 ${targetVersion} 已安装，正在重新加载扩展并恢复功能…`,
  }, chromeApi);
  logUpdate('info', 'update_install_complete_reload_requested', { targetVersion, nativeVersion: installed?.version ?? null });
  await sleep(300);
  chromeApi.runtime.reload();
  return { reloadRequested: true };
}

export async function checkAndMaybeInstall(
  reason = 'scheduled',
  chromeApi = globalThis.chrome,
  { force = false, install = true } = {},
) {
  if (updateTask) return updateTask;
  updateTask = (async () => {
    const currentVersion = chromeApi.runtime.getManifest().version;
    try {
      const status = await getUpdateStatus(chromeApi);
      if (TRANSIENT_PHASES.has(status?.phase)) {
        await resumeInterruptedUpdate(chromeApi);
        return { updateInProgress: true, currentVersion, targetVersion: status.targetVersion ?? null };
      }

      if (!force) {
        const policy = await fetchManagedUpdatePolicy();
        if (!policy.enabled) {
          await setActionUpdateState({ available: false }, chromeApi);
          await setUpdateStatus({
            phase: 'managed_disabled', percent: 0, targetVersion: null,
            message: '服务端已停用新版本通知与自动更新。',
          }, chromeApi);
          logUpdate('info', 'managed_auto_update_disabled', { reason, syncGeneration: policy.syncGeneration });
          return { managedDisabled: true, currentVersion };
        }
      }

      const release = await fetchLatestRelease(currentVersion);
      if (!release.updateAvailable) {
        await setActionUpdateState({ available: false }, chromeApi);
        if (reason === 'ui_check') {
          await setUpdateStatus({
            phase: 'up_to_date', percent: 100,
            targetVersion: release.latestVersion,
            message: `当前 ${currentVersion} 已是最新正式版。`,
          }, chromeApi);
        }
        return release;
      }

      await setActionUpdateState({ available: true, version: release.latestVersion }, chromeApi);
      await setUpdateStatus({
        phase: 'ready', percent: 12,
        targetVersion: release.latestVersion,
        message: install
          ? `服务端已发布 GPTWork ${release.latestVersion}，正在准备自动更新…`
          : `发现 GPTWork ${release.latestVersion}，可立即更新。`,
      }, chromeApi);
      logUpdate('info', 'server_release_notification_received', {
        reason,
        currentVersion,
        latestVersion: release.latestVersion,
        forcedByAdmin: force,
        install,
      });

      if (!install) return release;

      const platform = await getPlatformInfo(chromeApi);
      let nativeStatus = null;
      try { nativeStatus = await nativeRequest('get_status', {}, chromeApi, 7_000); } catch {}
      if (!shouldAutoInstall({
        platformOs: platform?.os,
        nativeConnected: Boolean(nativeStatus?.version),
        nativeVersion: nativeStatus?.version,
      })) {
        const message = platform?.os === 'win'
          ? `发现 ${release.latestVersion}；本地 Core 暂不满足安全自动更新条件，请使用正式安装包`
          : `发现 ${release.latestVersion}；当前系统请使用 GPTWork 正式发布包`;
        await setUpdateStatus({
          phase: 'ready', percent: 12,
          targetVersion: release.latestVersion,
          nativeVersion: nativeStatus?.version ?? null,
          message,
        }, chromeApi);
        return release;
      }

      if (!force && await recentFailedAttempt(release.latestVersion, chromeApi)) return release;
      await autoInstallWindows(release, nativeStatus, chromeApi);
      return release;
    } catch (error) {
      const status = await getUpdateStatus(chromeApi).catch(() => null);
      const targetVersion = status?.targetVersion ?? null;
      if (targetVersion) await recordAttempt(targetVersion, 'failed', { error: errorText(error) }, chromeApi).catch(() => {});
      await restoreAfterFailedUpdate(chromeApi).catch(() => {});
      await setActionUpdateState({ available: Boolean(targetVersion), version: targetVersion, error: Boolean(targetVersion) }, chromeApi);
      await setUpdateStatus({
        phase: 'error', percent: Math.min(99, Math.max(0, Number(status?.percent || 0))),
        targetVersion,
        message: `更新失败：${errorText(error)}`,
        error: errorText(error),
        failedAt: new Date().toISOString(),
      }, chromeApi).catch(() => {});
      logUpdate('error', 'background_auto_update_failed', { reason, targetVersion, error: errorText(error), forcedByAdmin: force });
      throw error;
    }
  })().finally(() => { updateTask = null; });
  return updateTask;
}

async function notificationRound(chromeApi = globalThis.chrome) {
  const policy = await fetchManagedUpdatePolicy();
  if (!policy.enabled) return { disabled: true, generation: policy.syncGeneration };
  const stored = await chromeApi.storage.local.get(RELEASE_GENERATION_KEY);
  const generation = String(stored[RELEASE_GENERATION_KEY] || '');
  const response = await fetch(releaseNotificationUrl(generation), {
    cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`release notification service failed (${response.status})`);
  const payload = await response.json();
  if (payload?.generation) {
    await chromeApi.storage.local.set({ [RELEASE_GENERATION_KEY]: String(payload.generation) });
  }
  if (payload?.changed) await checkAndMaybeInstall('server_notification', chromeApi);
  return payload;
}

async function runNotificationLoop(chromeApi = globalThis.chrome) {
  if (notificationTask) return notificationTask;
  notificationTask = (async () => {
    for (let round = 0; round < LONG_POLL_ROUNDS; round += 1) {
      try {
        const result = await notificationRound(chromeApi);
        if (result?.disabled) break;
      } catch (error) {
        logUpdate('warn', 'release_notification_channel_error', { error: errorText(error) });
        break;
      }
      if (round + 1 < LONG_POLL_ROUNDS) await sleep(500);
    }
  })().finally(() => { notificationTask = null; });
  return notificationTask;
}

async function clientControlRound(chromeApi = globalThis.chrome) {
  const stored = await chromeApi.storage.local.get([
    ACCOUNT_SESSION_KEY,
    ADMIN_UPDATE_GENERATION_KEY,
    ACCOUNT_SYNC_GENERATION_KEY,
  ]);
  const token = String(stored[ACCOUNT_SESSION_KEY] || '');
  if (!token) return { authenticated: false };
  const sinceUpdate = Math.max(0, Number(stored[ADMIN_UPDATE_GENERATION_KEY] || 0));
  const sinceAccount = Math.max(0, Number(stored[ACCOUNT_SYNC_GENERATION_KEY] || 0));
  const response = await fetch(clientControlUrl({ sinceUpdate, sinceAccount }), {
    cache: 'no-store', credentials: 'omit',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) return { authenticated: false };
  if (!response.ok) throw new Error(`client control service failed (${response.status})`);
  const payload = await response.json();
  const control = payload?.control || {};

  if (control.accountSync && Number(control.accountSyncGeneration || 0) > sinceAccount) {
    await scheduleAccountRefresh(chromeApi);
    await chromeApi.storage.local.set({ [ACCOUNT_SYNC_GENERATION_KEY]: Number(control.accountSyncGeneration) });
    logUpdate('info', 'admin_account_sync_scheduled', { generation: Number(control.accountSyncGeneration) });
  }

  if (control.forceUpdate && Number(control.updateGeneration || 0) > sinceUpdate) {
    const generation = Number(control.updateGeneration);
    await chromeApi.storage.local.set({ [ADMIN_UPDATE_GENERATION_KEY]: generation });
    try {
      await checkAndMaybeInstall('admin_sync', chromeApi, { force: true, install: true });
      logUpdate('info', 'admin_update_command_applied', { generation });
    } catch (error) {
      await chromeApi.storage.local.set({ [ADMIN_UPDATE_GENERATION_KEY]: sinceUpdate }).catch(() => {});
      throw error;
    }
  }
  return control;
}

async function runClientControlLoop(chromeApi = globalThis.chrome) {
  if (clientControlTask) return clientControlTask;
  clientControlTask = (async () => {
    for (let round = 0; round < LONG_POLL_ROUNDS; round += 1) {
      try {
        const result = await clientControlRound(chromeApi);
        if (result?.authenticated === false) break;
      } catch (error) {
        logUpdate('warn', 'client_control_channel_error', { error: errorText(error) });
        break;
      }
      if (round + 1 < LONG_POLL_ROUNDS) await sleep(500);
    }
  })().finally(() => { clientControlTask = null; });
  return clientControlTask;
}

function handleUpdateMessage(message, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;
  if (!['GPTWORK_UPDATE_STATUS_GET', 'GPTWORK_UPDATE_CHECK', 'GPTWORK_UPDATE_INSTALL'].includes(message.type)) return false;

  const run = async () => {
    if (message.type === 'GPTWORK_UPDATE_STATUS_GET') {
      return (await getUpdateStatus()) || {
        schemaVersion: 3,
        phase: 'idle',
        percent: 0,
        targetVersion: null,
        message: '尚未开始更新。',
      };
    }
    if (message.type === 'GPTWORK_UPDATE_CHECK') {
      return checkAndMaybeInstall('ui_check', globalThis.chrome, { force: true, install: false });
    }
    return checkAndMaybeInstall('ui_install', globalThis.chrome, { force: true, install: true });
  };

  run().then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: errorText(error) }),
  );
  return true;
}

export async function initializeBackgroundUpdater(chromeApi = globalThis.chrome) {
  if (!chromeApi?.runtime?.getManifest || !chromeApi?.alarms || !chromeApi?.storage?.local) return;
  await chromeApi.alarms.create(RELEASE_CHECK_ALARM, { periodInMinutes: AUTO_UPDATE_ALARM_MINUTES });
  const resumed = await resumeInterruptedUpdate(chromeApi);
  if (resumed) return;
  void runClientControlLoop(chromeApi);
  void checkAndMaybeInstall('startup', chromeApi).catch(() => {});
  void runNotificationLoop(chromeApi);
}

if (globalThis.chrome?.runtime?.onInstalled && globalThis.chrome?.runtime?.onStartup) {
  chrome.runtime.onMessage.addListener(handleUpdateMessage);
  chrome.runtime.onInstalled.addListener(() => void initializeBackgroundUpdater());
  chrome.runtime.onStartup.addListener(() => void initializeBackgroundUpdater());
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== RELEASE_CHECK_ALARM) return;
    void runClientControlLoop();
    void checkAndMaybeInstall('alarm').catch(() => {});
    void runNotificationLoop();
  });
  void initializeBackgroundUpdater();
}
