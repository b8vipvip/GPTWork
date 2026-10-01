import { appendRuntimeLog } from './runtime-log.js';

export const RELEASE_API_URL = 'https://gptlock.mv3.cn/site/api/releases';
export const RELEASES_URL = 'https://gptlock.mv3.cn/releases';
export const WINDOWS_INSTALLER_NAME = 'GPTWorkSetup-x64.exe';
export const WINDOWS_DOWNLOAD_FILENAME = 'GPTWork/GPTWorkSetup-x64.exe';
export const UPDATE_STATUS_KEY = 'gptlockUiUpdateStatus';
export const RELIABLE_WINDOWS_UPDATER_MIN_CORE_VERSION = '0.5.24';
const RELEASE_DOWNLOAD_PREFIX = '/downloads/releases/';

function numericParts(value) {
  const normalized = String(value || '').trim().replace(/^v/i, '');
  if (!/^\d+(?:\.\d+){1,3}$/.test(normalized)) return null;
  return normalized.split('.').map((part) => Number.parseInt(part, 10));
}

export function normalizeVersion(value) {
  const parts = numericParts(value);
  return parts ? parts.join('.') : null;
}

export function compareVersions(left, right) {
  const leftParts = numericParts(left);
  const rightParts = numericParts(right);
  if (!leftParts || !rightParts) return null;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

export function supportsReliableWindowsOneClickUpdate(nativeVersion) {
  const comparison = compareVersions(nativeVersion, RELIABLE_WINDOWS_UPDATER_MIN_CORE_VERSION);
  return comparison === 0 || comparison === 1;
}

function sha256FromDigest(value) {
  const match = String(value || '').trim().match(/^sha256:([0-9a-f]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

export function secureServerDownloadUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'gptlock.mv3.cn') return null;
    if (!url.pathname.startsWith(RELEASE_DOWNLOAD_PREFIX)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function logUpdate(level, event, details = {}) {
  if (!globalThis.chrome?.storage?.local) return;
  void appendRuntimeLog(level, 'update', event, details).catch(() => {});
}

export function normalizeLatestReleasePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!Array.isArray(payload.releases)) return payload;
  const release = payload.releases[0] || null;
  if (!release) return null;
  return {
    tag_name: String(release.tag || ''),
    name: String(release.name || release.tag || ''),
    html_url: RELEASES_URL,
    draft: false,
    prerelease: false,
    published_at: release.publishedAt || null,
    assets: Array.isArray(release.assets) ? release.assets.map((asset) => ({
      name: String(asset?.name || ''),
      browser_download_url: String(asset?.url || ''),
      digest: String(asset?.digest || ''),
      size: Number(asset?.size || 0),
    })) : [],
  };
}

export function parseLatestRelease(rawRelease, currentVersion) {
  const release = normalizeLatestReleasePayload(rawRelease);
  if (!release || release.draft || release.prerelease) {
    throw new Error('Latest GPTWork release is unavailable / 最新正式版本不可用');
  }
  const latestVersion = normalizeVersion(release.tag_name);
  const normalizedCurrent = normalizeVersion(currentVersion);
  if (!latestVersion || !normalizedCurrent) {
    throw new Error('Release version is invalid / 发布版本号无效');
  }
  const installerAsset = Array.isArray(release.assets)
    ? release.assets.find((asset) => asset?.name === WINDOWS_INSTALLER_NAME)
    : null;
  const installerSha256 = sha256FromDigest(installerAsset?.digest);
  const installerUrl = secureServerDownloadUrl(installerAsset?.browser_download_url);
  if (!installerAsset || !installerUrl || !installerSha256) {
    throw new Error('Latest release is missing a verified server-mirrored Windows installer / 最新版本缺少服务端已校验的 Windows 安装器');
  }
  const comparison = compareVersions(latestVersion, normalizedCurrent);
  return {
    currentVersion: normalizedCurrent,
    latestVersion,
    tag: String(release.tag_name || `v${latestVersion}`),
    releaseUrl: RELEASES_URL,
    updateAvailable: comparison === 1,
    installer: {
      name: WINDOWS_INSTALLER_NAME,
      url: installerUrl,
      sha256: installerSha256,
      size: Number.isFinite(installerAsset.size) ? installerAsset.size : null,
    },
  };
}

export async function fetchLatestRelease(currentVersion, fetchImpl = fetch) {
  logUpdate('info', 'update_check_started', { currentVersion: normalizeVersion(currentVersion) || String(currentVersion || '') });
  try {
    const response = await fetchImpl(RELEASE_API_URL, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`GPTWork update service failed (${response.status}) / GPTWork 更新服务不可用`);
    }
    const release = parseLatestRelease(await response.json(), currentVersion);
    logUpdate('info', 'update_check_completed', {
      currentVersion: release.currentVersion,
      latestVersion: release.latestVersion,
      updateAvailable: release.updateAvailable,
      source: 'server_mirror',
    });
    return release;
  } catch (error) {
    logUpdate('error', 'update_check_failed', {
      currentVersion: normalizeVersion(currentVersion) || String(currentVersion || ''),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function isInstallActionReady(installButton) {
  return Boolean(installButton && installButton.hidden === false && installButton.disabled === false);
}

export function bindAutomaticInstallAfterCheck({
  checkButton,
  installButton,
  MutationObserverImpl = globalThis.MutationObserver,
  timeoutMs = 60_000,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (!checkButton || !installButton || typeof MutationObserverImpl !== 'function') return () => {};

  let cancelPending = () => {};
  const onCheck = () => {
    cancelPending();
    let completed = false;
    let timer = null;
    let observer = null;

    const cleanup = () => {
      observer?.disconnect();
      if (timer !== null) clearTimeoutImpl(timer);
      timer = null;
    };
    cancelPending = cleanup;

    const maybeInstall = () => {
      if (completed || !isInstallActionReady(installButton)) return false;
      completed = true;
      cleanup();
      logUpdate('info', 'update_auto_install_triggered');
      installButton.click();
      return true;
    };

    observer = new MutationObserverImpl(() => { maybeInstall(); });
    observer.observe(installButton, {
      attributes: true,
      attributeFilter: ['hidden', 'disabled'],
    });
    timer = setTimeoutImpl(() => {
      if (!completed) logUpdate('warn', 'update_auto_install_wait_expired', { timeoutMs });
      cleanup();
    }, timeoutMs);
    maybeInstall();
  };

  checkButton.addEventListener('click', onCheck);
  return () => {
    cancelPending();
    checkButton.removeEventListener('click', onCheck);
  };
}

export function updateStatusEventName(phase) {
  const events = {
    downloading: 'update_download_started',
    installing: 'update_install_started',
    complete: 'update_completed',
    error: 'update_failed',
  };
  return events[phase] || null;
}

export function bindUpdateStatusLogging(chromeApi = globalThis.chrome) {
  if (!chromeApi?.storage?.onChanged?.addListener) return () => {};
  const listener = (changes, areaName) => {
    if (areaName !== 'local' || !changes?.[UPDATE_STATUS_KEY]) return;
    const change = changes[UPDATE_STATUS_KEY];
    const previousPhase = change.oldValue?.phase ?? null;
    const status = change.newValue;
    const nextPhase = status?.phase ?? null;
    if (previousPhase === nextPhase) return;
    const event = updateStatusEventName(nextPhase);
    if (!event) return;
    logUpdate(nextPhase === 'error' ? 'error' : 'info', event, {
      phase: nextPhase,
      targetVersion: status.targetVersion ?? null,
      nativeVersion: status.nativeVersion ?? null,
      error: status.error ?? null,
    });
  };
  chromeApi.storage.onChanged.addListener(listener);
  return () => chromeApi.storage.onChanged.removeListener?.(listener);
}

if (typeof document !== 'undefined') {
  const checkButton = document.getElementById('checkUpdate');
  const installButton = document.getElementById('installUpdate');
  if (checkButton && installButton) {
    bindAutomaticInstallAfterCheck({ checkButton, installButton });
    bindUpdateStatusLogging();
  }
}
