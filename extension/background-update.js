import {
  compareVersions,
  fetchLatestRelease,
  supportsReliableWindowsOneClickUpdate,
  UPDATE_STATUS_KEY,
  WINDOWS_DOWNLOAD_FILENAME,
} from './update-manager.js';
import { appendRuntimeLog } from './runtime-log.js';

export const RELEASE_NOTIFICATION_URL = 'https://gptlock.mv3.cn/site/api/releases/notifications';
export const CLIENT_UPDATE_POLICY_URL = 'https://gptlock.mv3.cn/site/api/client-update/config';
export const CLIENT_CONTROL_URL = 'https://gptlock.mv3.cn/api/v1/client/control';
export const RELEASE_CHECK_ALARM = 'gptlock-release-check';
export const ACCOUNT_REFRESH_ALARM = 'gptlock-account-refresh';
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
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;
const INSTALL_INITIAL_WAIT_MS = 8 * 1000;
const INSTALL_POLL_MS = 3 * 1000;
const NATIVE_TIMEOUT_MS = 12 * 1000;
const LONG_POLL_ROUNDS = 3;
const ACCOUNT_REFRESH_SOON_MS = 250;

let updateTask = null;
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

export async function scheduleAccountRefresh(chromeApi = globalThis.chrome) {
  if (!chromeApi?.alarms?.create) throw new Error('Account refresh alarm is unavailable');
  // background-update.js runs in the same MV3 service-worker frame as background.js.
  // runtime.sendMessage() does not deliver back into the sender's own frame, so using
  // it here can produce "Receiving end does not exist" even while the worker is alive.
  // Re-arm the existing heartbeat alarm to fire promptly and keep its 1-minute cadence.
  await chromeApi.alarms.create(ACCOUNT_REFRESH_ALARM, {
    when: Date.now() + ACCOUNT_REFRESH_SOON_MS,
    periodInMinutes: AUTO_UPDATE_ALARM_MINUTES,
  });
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

async function setUpdateStatus(status, chromeApi = globalThis.chrome) {
  await chromeApi.storage.local.set({
    [UPDATE_STATUS_KEY]: {
      schemaVersion: 2,
      updatedAt: new Date().toISOString(),
      ...status,
    },
  });
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
    ? `GPTWork ${version || ''} 自动更新失败，点击查看`
    : installing
      ? `GPTWork 正在自动更新到 ${version || '新版本'}`
      : `GPTWork ${version || '新版本'} 已由服务端发布`;
  await chromeApi.action.setBadgeText({ text: badge }).catch(() => {});
  await chromeApi.action.setTitle({ title }).catch(() => {});
}

async function waitForDownload(downloadId, chromeApi = globalThis.chrome) {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const item = await findDownload(downloadId, chromeApi);
    if (item?.state === 'complete') {
      if (item.danger && !['safe', 'accepted'].includes(item.danger)) {
        throw new Error(`浏览器安全检查阻止安装器：${item.danger}`);
      }
      if (!item.filename) throw new Error('无法取得下载后的安装器路径');
      return item;
    }
    if (item?.state === 'interrupted') throw new Error(`安装器下载中断：${item.error || 'unknown'}`);
    await sleep(400);
  }
  throw new Error('安装器下载超时');
}

async function waitForInstalledCore(targetVersion, chromeApi = globalThis.chrome) {
  await sleep(INSTALL_INITIAL_WAIT_MS);
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  let lastVersion = null;
  while (Date.now() < deadline) {
    try {
      const status = await nativeRequest('get_status', {}, chromeApi, 7_000);
      lastVersion = status?.version || lastVersion;
      if (compareVersions(status?.version, targetVersion) >= 0) return status;
    } catch {
      // The verified installer may still be replacing the Native Messaging host.
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

async function autoInstallWindows(release, nativeStatus, chromeApi = globalThis.chrome) {
  const targetVersion = release.latestVersion;
  await recordAttempt(targetVersion, 'running', {}, chromeApi);
  await setActionUpdateState({ available: true, version: targetVersion, installing: true }, chromeApi);
  await setUpdateStatus({
    phase: 'downloading', percent: 15,
    targetVersion,
    nativeVersion: nativeStatus?.version ?? null,
    message: `服务端已发布 ${targetVersion}，正在自动下载安装包…`,
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
  const download = await waitForDownload(downloadId, chromeApi);

  await setUpdateStatus({
    phase: 'verifying', percent: 55,
    targetVersion,
    nativeVersion: nativeStatus?.version ?? null,
    message: '安装包已从 GPTWork 服务端下载，正在校验 SHA-256…',
    downloadId,
  }, chromeApi);
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
    message: `正在后台安装 ${targetVersion}，GPTWork Core 会短暂重启…`,
    launcherStrategy: prepared?.launcherStrategy ?? null,
    launcherProcessId: prepared?.launcherProcessId ?? null,
  }, chromeApi);

  const installed = await waitForInstalledCore(targetVersion, chromeApi);
  await recordAttempt(targetVersion, 'complete', { nativeVersion: installed?.version ?? targetVersion }, chromeApi);
  await setUpdateStatus({
    phase: 'complete', percent: 100,
    targetVersion,
    nativeVersion: installed?.version ?? targetVersion,
    message: `自动更新完成：${targetVersion}，正在重新加载扩展…`,
    completedAt: new Date().toISOString(),
  }, chromeApi);
  await setActionUpdateState({ available: false }, chromeApi);
  logUpdate('info', 'background_auto_update_completed', {
    targetVersion,
    nativeVersion: installed?.version ?? null,
  });
  await sleep(900);
  chromeApi.runtime.reload();
}

export async function checkAndMaybeInstall(reason = 'scheduled', chromeApi = globalThis.chrome, { force = false } = {}) {
  if (updateTask) return updateTask;
  updateTask = (async () => {
    const currentVersion = chromeApi.runtime.getManifest().version;
    try {
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
        return release;
      }

      await setActionUpdateState({ available: true, version: release.latestVersion }, chromeApi);
      await setUpdateStatus({
        phase: 'ready', percent: 12,
        targetVersion: release.latestVersion,
        message: `服务端已发布 GPTWork ${release.latestVersion}，正在准备自动更新…`,
      }, chromeApi);
      logUpdate('info', 'server_release_notification_received', {
        reason,
        currentVersion,
        latestVersion: release.latestVersion,
        forcedByAdmin: force,
      });

      const platform = await getPlatformInfo(chromeApi);
      let nativeStatus = null;
      try { nativeStatus = await nativeRequest('get_status', {}, chromeApi, 7_000); } catch {}
      if (!shouldAutoInstall({
        platformOs: platform?.os,
        nativeConnected: Boolean(nativeStatus?.version),
        nativeVersion: nativeStatus?.version,
      })) {
        const message = platform?.os === 'win'
          ? `发现 ${release.latestVersion}；本地 Core 暂不满足安全自动更新条件，点击 GPTWork 查看`
          : `发现 ${release.latestVersion}；已通知客户端，当前系统更新包从 GPTWork 官网提供`;
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
      const targetVersion = (await chromeApi.storage.local.get(UPDATE_STATUS_KEY))[UPDATE_STATUS_KEY]?.targetVersion ?? null;
      if (targetVersion) await recordAttempt(targetVersion, 'failed', { error: errorText(error) }, chromeApi).catch(() => {});
      await setActionUpdateState({ available: Boolean(targetVersion), version: targetVersion, error: Boolean(targetVersion) }, chromeApi);
      await setUpdateStatus({
        phase: 'error', percent: 0,
        targetVersion,
        message: `自动更新检查失败：${errorText(error)}`,
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
      await checkAndMaybeInstall('admin_sync', chromeApi, { force: true });
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

export async function initializeBackgroundUpdater(chromeApi = globalThis.chrome) {
  if (!chromeApi?.runtime?.getManifest || !chromeApi?.alarms || !chromeApi?.storage?.local) return;
  await chromeApi.alarms.create(RELEASE_CHECK_ALARM, { periodInMinutes: AUTO_UPDATE_ALARM_MINUTES });
  void runClientControlLoop(chromeApi);
  void checkAndMaybeInstall('startup', chromeApi).catch(() => {});
  void runNotificationLoop(chromeApi);
}

if (globalThis.chrome?.runtime?.onInstalled && globalThis.chrome?.runtime?.onStartup) {
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
