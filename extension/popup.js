import { classifyNativeError, nativeHelp, RELEASES_URL } from './native-status.js';
import {
  compareVersions,
  fetchLatestRelease,
  RELIABLE_WINDOWS_UPDATER_MIN_CORE_VERSION,
  supportsReliableWindowsOneClickUpdate,
  WINDOWS_DOWNLOAD_FILENAME,
} from './update-manager.js';

const NATIVE_HOST = 'com.gptlock.core';
const UPDATE_STATUS_KEY = 'gptlockUiUpdateStatus';
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;
const INSTALL_INITIAL_WAIT_MS = 10 * 1000;
const INSTALL_POLL_MS = 5 * 1000;

const elements = {
  version: document.getElementById('version'),
  verdict: document.getElementById('verdict'),
  guardTitle: document.getElementById('guardTitle'),
  guardDetail: document.getElementById('guardDetail'),
  native: document.getElementById('native'),
  monitor: document.getElementById('monitor'),
  pageState: document.getElementById('pageState'),
  responseState: document.getElementById('responseState'),
  autoVerify: document.getElementById('autoVerify'),
  reconnect: document.getElementById('reconnect'),
  logs: document.getElementById('logs'),
  options: document.getElementById('options'),
  message: document.getElementById('message'),
  installHelp: document.getElementById('installHelp'),
  installTitle: document.getElementById('installTitle'),
  installDetail: document.getElementById('installDetail'),
  installCore: document.getElementById('installCore'),
  currentVersion: document.getElementById('currentVersion'),
  updateDetail: document.getElementById('updateDetail'),
  checkUpdate: document.getElementById('checkUpdate'),
  installUpdate: document.getElementById('installUpdate'),
};

let lastState = null;
let latestRelease = null;
let updateBusy = false;
let platform = null;

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || 'Extension request failed'));
      else resolve(response.data);
    });
  });
}

function getPlatformInfo() {
  return new Promise((resolve) => {
    chrome.runtime.getPlatformInfo((info) => resolve(info ?? {}));
  });
}

function downloadFile(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!Number.isInteger(downloadId)) reject(new Error('Browser did not start the installer download / 浏览器未启动安装器下载'));
      else resolve(downloadId);
    });
  });
}

function findDownload(downloadId) {
  return new Promise((resolve, reject) => {
    chrome.downloads.search({ id: downloadId }, (items) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(items?.[0] ?? null);
    });
  });
}

function nativeRequest(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = `popup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let settled = false;
    let port;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch {}
      callback(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`Native request timed out: ${type}`));
    }, 12000);

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
      port.onMessage.addListener((response) => {
        if (String(response?.id) !== id) return;
        if (response.ok) finish(resolve, response.data);
        else finish(reject, new Error(response?.error?.messageZhCn || response?.error?.messageEn || 'Native request failed'));
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        finish(reject, new Error(chrome.runtime.lastError?.message || 'Native host disconnected'));
      });
      port.postMessage({ id, type, ...payload });
    } catch (error) {
      finish(reject, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDownload(downloadId) {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const item = await findDownload(downloadId);
    if (item?.state === 'complete') {
      if (item.danger && !['safe', 'accepted'].includes(item.danger)) {
        throw new Error(`浏览器安全检查阻止安装器：${item.danger} / Browser blocked the installer`);
      }
      if (!item.filename) throw new Error('Downloaded installer path is unavailable / 无法取得下载后的安装器路径');
      return item;
    }
    if (item?.state === 'interrupted') {
      throw new Error(`安装器下载中断：${item.error || 'unknown'} / Installer download interrupted`);
    }
    await sleep(350);
  }
  throw new Error('安装器下载超时 / Installer download timed out');
}

function valuePair(model, reasoning) {
  return model || reasoning ? `${model || 'model ?'} · ${reasoning || 'reasoning ?'}` : '无 / None';
}

function autoVerificationAppliesToLatestRequest(auto, tab) {
  const completedAt = Date.parse(auto?.completedAt || '');
  const latestRequestAt = Date.parse(tab?.lastRequest?.capturedAt || '');
  if (!Number.isFinite(completedAt)) return false;
  return !Number.isFinite(latestRequestAt) || latestRequestAt <= completedAt;
}

function hasConfirmedAutoEvidence(auto, policy, tab) {
  return Boolean(
    auto
      && !auto.running
      && auto.outcome === 'verified'
      && auto.evidenceSource === 'network_response_metadata'
      && auto.responseModel
      && auto.responseReasoning
      && policy?.lockedModels?.includes(auto.responseModel)
      && policy?.allowedReasoningLevels?.includes(auto.responseReasoning)
      && autoVerificationAppliesToLatestRequest(auto, tab),
  );
}

function autoReasonText(auto) {
  const reasons = {
    confirmed_model_mismatch: '响应明确确认了不允许的模型。',
    reasoning_not_exposed: '模型已确认，但 ChatGPT 未暴露推理强度元数据。',
    model_not_exposed: '正式请求已经锁定，但流式响应和会话详情都没有暴露可验证模型元数据。',
    downstream_model_not_exposed: '已跟踪 handoff 后续流，但尚未从嵌套流元数据中解析出模型。',
    response_verification_timeout: '等待响应确认超时。',
    conversation_evidence_fetch_failed: '流式响应证据不足，且会话详情回查失败。',
    response_body_read_failed: '浏览器无法读取响应体。',
    metadata_incomplete: '响应元数据仍不完整。',
  };
  return reasons[auto?.reason] || auto?.reason || null;
}

function renderUpdate(release = latestRelease) {
  const currentVersion = chrome.runtime.getManifest().version;
  elements.currentVersion.textContent = currentVersion;
  elements.installUpdate.hidden = true;
  elements.installUpdate.disabled = updateBusy;
  elements.checkUpdate.disabled = updateBusy;

  if (!release) {
    elements.updateDetail.textContent = `当前版本 ${currentVersion} · 点击检查最新版本`;
    return;
  }
  if (release.updateAvailable) {
    const nativeVersion = lastState?.nativeStatus?.version ?? null;
    const canOneClick = platform?.os === 'win'
      && Boolean(lastState?.nativeStatus?.connected)
      && supportsReliableWindowsOneClickUpdate(nativeVersion);
    if (canOneClick) {
      elements.updateDetail.textContent = `当前 ${currentVersion} · 最新 ${release.latestVersion} · Core ${nativeVersion} 支持安全一键更新`;
      elements.installUpdate.textContent = '立即更新';
    } else if (platform?.os === 'win') {
      elements.updateDetail.textContent = `当前 ${currentVersion} · 最新 ${release.latestVersion} · Core ${nativeVersion || '未知'} 低于安全更新基线 ${RELIABLE_WINDOWS_UPDATER_MIN_CORE_VERSION}；需一次性从发布页安装`;
      elements.installUpdate.textContent = '打开发布页';
    } else {
      elements.updateDetail.textContent = `当前 ${currentVersion} · 最新 ${release.latestVersion} · 当前系统请从发布页安装`;
      elements.installUpdate.textContent = '打开发布页';
    }
    elements.installUpdate.hidden = false;
    return;
  }
  const comparison = compareVersions(currentVersion, release.latestVersion);
  elements.updateDetail.textContent = comparison === 1
    ? `当前 ${currentVersion} · 公开正式版 ${release.latestVersion} · 当前版本较新`
    : `当前 ${currentVersion} · 已是最新正式版`;
}

async function renderStoredUpdateStatus() {
  const stored = await chrome.storage.local.get(UPDATE_STATUS_KEY);
  const status = stored[UPDATE_STATUS_KEY];
  if (!status?.targetVersion) return;
  const currentVersion = chrome.runtime.getManifest().version;
  if (status.phase === 'installing') {
    elements.updateDetail.textContent = `正在安装 ${status.targetVersion} · 若弹窗关闭，安装仍会继续`;
  } else if (status.phase === 'complete' && compareVersions(currentVersion, status.targetVersion) === -1) {
    elements.updateDetail.textContent = `本地核心已更新到 ${status.targetVersion}，但扩展仍是 ${currentVersion}；请完全重启浏览器以加载新扩展文件`;
  }
}

function render(state) {
  lastState = state;
  renderUpdate(latestRelease);
  elements.version.textContent = state.extensionVersion || '';
  elements.currentVersion.textContent = state.extensionVersion || chrome.runtime.getManifest().version;
  const native = state.nativeStatus ?? {};
  const tab = state.tabState;
  const guard = tab?.guard;
  const auto = tab?.autoVerification;
  const autoApplies = autoVerificationAppliesToLatestRequest(auto, tab);
  const autoEvidenceConfirmed = hasConfirmedAutoEvidence(auto, state.policy, tab);
  elements.native.textContent = native.connected
    ? `已连接 / Online${native.version ? ` · ${native.version}` : ''}`
    : `离线 / Offline${native.lastError ? ` · ${native.lastError}` : ''}`;
  elements.monitor.textContent = tab?.monitor?.attached
    ? '已连接，请求会在发送前检查 / Attached'
    : `未连接，聊天保持可用 / Detached${tab?.monitor?.error ? ` · ${tab.monitor.error}` : ''}`;
  elements.pageState.textContent = valuePair(tab?.pageObservation?.model, tab?.pageObservation?.reasoning);
  const responseValue = autoEvidenceConfirmed
    ? valuePair(auto.responseModel, auto.responseReasoning)
    : valuePair(tab?.lastVerification?.model, tab?.lastVerification?.reasoning);
  elements.responseState.textContent = tab?.evidenceIssue && !autoEvidenceConfirmed
    ? `${responseValue} · ${tab.evidenceIssue}`
    : responseValue;
  const nativeErrorCode = native.errorCode || classifyNativeError(native.lastError);
  elements.installHelp.hidden = Boolean(native.connected);
  if (!native.connected) {
    const help = nativeHelp(nativeErrorCode);
    elements.installTitle.textContent = help.title;
    elements.installDetail.textContent = `${help.detail} 请求锁定器仍会由扩展尝试运行；本地核心主要负责响应证据审计。`;
  }

  const states = {
    lock_ready: ['请求拦截已就绪 / Interceptor ready', '正式聊天请求会在发送前按锁定策略检查/改写；此状态只表示请求层就绪，不代表后端响应已经确认。', 'good'],
    verified: ['锁定已确认 / Verified', '已取得符合策略的后端响应元数据；这是响应层确认，不依赖页面模型文字。', 'good'],
    mismatch: guard?.canSend
      ? ['确认有告警 / Warning', '响应确认存在非模型级异常；聊天保持可用。', 'wait']
      : ['模型不匹配 / Model mismatch', '服务器响应确认模型不符合锁定策略，强制模式已阻断后续发送。', 'bad'],
    unverified: ['响应未完全确认 / Unverified', '当前最新帧没有同时提供可信模型与推理强度；如果本轮自动验证此前已取得完整后端证据，会保留该轮已确认结果。', 'wait'],
    waiting: ['请求已锁，等待确认 / Waiting', '本次正式请求已进入发送流程，正在等待后端响应元数据确认。', 'wait'],
    preflight_mismatch: ['页面选择不同 / UI differs', '页面文字与策略不同，但页面状态只作辅助；正式请求仍会在网络层尝试锁定。', 'wait'],
    preflight_unknown: ['页面选择未知 / UI unknown', '页面没有暴露完整选择；页面状态不是后端模型证明。', 'wait'],
    monitor_offline: ['请求锁定器离线 / Interceptor offline', '浏览器调试连接不可用；GPTWork 会告警但不会卡住聊天。', 'wait'],
    verification_disabled: ['请求锁定已启用 / Lock only', '响应确认已关闭；正式请求仍会在发送前尝试锁定。', 'good'],
    core_offline: ['本地核心离线 / Core offline', '请求锁定仍由扩展执行；响应审计不可用，聊天不会被阻断。', 'wait'],
    error: ['响应确认错误 / Verification error', tab?.lastError || 'Verification failed; chat remains available.', 'wait'],
    outside_scope: ['不适用 / Out of scope', 'GPTWork 仅作用于 chatgpt.com。', 'off'],
    disabled: ['GPTWork 已关闭 / Disabled', '请求锁定与响应确认均已暂停。', 'off'],
  };
  let [title, detail, tone] = states[guard?.status] || ['无活动状态 / No active state', '请打开 chatgpt.com 后重试。', 'off'];
  if (auto?.running) {
    title = `自动验证中 ${auto.attempt || 1}/${auto.maxAttempts || 2} / Auto verifying`;
    detail = '正在等待本次真实聊天响应；如果响应证据不足，程序会自动跟踪 handoff 后续流并最多再发送一次测试消息。';
    tone = 'wait';
  } else if (auto?.completedAt && autoApplies) {
    if (autoEvidenceConfirmed) {
      title = '自动验证通过 / Verified';
      detail = `已完成 ${auto.attempts?.length || 1} 次尝试；后端流响应元数据确认 ${auto.responseModel} · ${auto.responseReasoning}。后续无模型字段的流帧不会抹掉这条已确认结果。`;
      tone = 'good';
    } else if (auto.outcome === 'model_verified_reasoning_unconfirmed') {
      title = '模型已确认，推理未确认 / Partial verification';
      detail = `已自动重试 ${auto.retries || 0} 次；${autoReasonText(auto)}`;
      tone = 'wait';
    } else {
      title = '自动验证未完全确认 / Auto verification incomplete';
      detail = `已自动尝试 ${auto.attempts?.length || 0} 次；${autoReasonText(auto) || '证据仍不足。'} 请求层锁定${auto.requestLockConfirmed ? '已确认' : '未确认'}。`;
      tone = auto.outcome === 'model_mismatch' ? 'bad' : 'wait';
    }
  }
  const reasonDetails = {
    model_missing: '当前响应帧未暴露可验证模型字段；不能单独据此推翻同一轮此前已经确认的后端证据。',
    reasoning_missing: '当前响应帧未暴露可验证推理强度字段；不能单独据此推翻同一轮此前已经确认的后端证据。',
    response_body_read_failed: '浏览器未能读取本次响应体；请求锁定不受影响。',
    response_model_not_exposed: 'ChatGPT 当前响应帧未暴露模型元数据。',
    response_reasoning_not_exposed: 'ChatGPT 当前响应帧未暴露推理强度元数据。',
    response_body_empty: '本次可读取响应体为空。',
    response_body_unparseable: '本次响应格式无法安全解析为元数据。',
    conversation_model_not_exposed: '会话详情也没有暴露模型元数据。',
    conversation_reasoning_not_exposed: '会话详情确认了模型，但没有暴露推理强度元数据。',
    auto_verify_response_timeout: '自动验证等待响应确认超时。',
    page_selection_missing: '页面 DOM 当前未识别出完整模型/推理选择；该项只作辅助，不作为后端模型证明。',
  };
  const rewrite = tab?.lastRewrite;
  const rewriteDetail = rewrite
    ? `最近请求锁：${rewrite.changed ? '已改写' : '已检查'}${rewrite.modelAfter ? ` → ${rewrite.modelAfter}` : ''}${rewrite.reason ? ` (${rewrite.reason})` : ''}`
    : null;
  const evidenceDetail = autoEvidenceConfirmed ? null : (reasonDetails[tab?.evidenceIssue] || reasonDetails[guard?.reason]);
  elements.verdict.textContent = title.split(' / ')[0];
  elements.verdict.className = `verdict ${tone}`;
  elements.guardTitle.textContent = title;
  const rawReason = guard?.reason && !evidenceDetail && !autoEvidenceConfirmed ? guard.reason : null;
  elements.guardDetail.textContent = [detail, rewriteDetail, evidenceDetail, rawReason].filter(Boolean).join(' · ');
  elements.autoVerify.disabled = !tab || !enabled;
  renderUpdate();
}

async function load() {
  render(await sendMessage({ type: 'GPTLOCK_GET_STATE' }));
  await renderStoredUpdateStatus();
}

async function checkUpdate() {
  if (updateBusy) return null;
  updateBusy = true;
  renderUpdate();
  elements.message.textContent = '正在通过浏览器检查 GitHub 正式版本 / Checking GitHub release…';
  try {
    platform ??= await getPlatformInfo();
    latestRelease = await fetchLatestRelease(chrome.runtime.getManifest().version);
    renderUpdate(latestRelease);
    elements.message.textContent = latestRelease.updateAvailable
      ? `发现新版本 ${latestRelease.latestVersion} / Update available.`
      : `当前已是最新版本 ${chrome.runtime.getManifest().version} / Up to date.`;
    return latestRelease;
  } catch (error) {
    elements.message.textContent = `检查更新失败 / Update check failed: ${error.message}`;
    throw error;
  } finally {
    updateBusy = false;
    renderUpdate(latestRelease);
  }
}

async function waitForInstalledCore(targetVersion) {
  await sleep(INSTALL_INITIAL_WAIT_MS);
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await sendMessage({ type: 'GPTLOCK_RECONNECT' });
      const state = await sendMessage({ type: 'GPTLOCK_GET_STATE' });
      const nativeVersion = state?.nativeStatus?.version;
      if (state?.nativeStatus?.connected && compareVersions(nativeVersion, targetVersion) >= 0) {
        return state;
      }
    } catch {
      // The installer may still be replacing the core executable. Retry below.
    }
    await sleep(INSTALL_POLL_MS);
  }
  throw new Error('等待新版本本地核心启动超时；安装可能已完成，请完全重启浏览器 / Timed out waiting for updated core');
}

async function installUpdate() {
  if (updateBusy) return;
  updateBusy = true;
  elements.checkUpdate.disabled = true;
  elements.installUpdate.disabled = true;
  try {
    platform ??= await getPlatformInfo();
    const release = latestRelease?.updateAvailable
      ? latestRelease
      : await fetchLatestRelease(chrome.runtime.getManifest().version);
    latestRelease = release;
    renderUpdate(release);
    if (!release.updateAvailable) {
      elements.message.textContent = '当前已经是最新版本 / Already up to date.';
      return;
    }
    if (platform.os !== 'win') {
      await chrome.tabs.create({ url: release.releaseUrl || RELEASES_URL });
      window.close();
      return;
    }
    const state = lastState || await sendMessage({ type: 'GPTLOCK_GET_STATE' });
    if (!state?.nativeStatus?.connected) {
      throw new Error('本地核心离线，无法执行一键安装；请先点击“重新连接”或运行一次安装器修复 / Native Core is offline');
    }
    if (!supportsReliableWindowsOneClickUpdate(state.nativeStatus.version)) {
      elements.message.textContent = `当前 Core ${state.nativeStatus.version || '未知'} 低于安全更新基线 ${RELIABLE_WINDOWS_UPDATER_MIN_CORE_VERSION}；请完成一次性手工升级。`;
      await chrome.tabs.create({ url: release.releaseUrl || RELEASES_URL });
      window.close();
      return;
    }

    elements.updateDetail.textContent = `正在下载 ${release.latestVersion} 安装器…`;
    elements.message.textContent = '浏览器正在下载官方 GitHub Release 安装器 / Downloading installer…';
    await chrome.storage.local.set({
      [UPDATE_STATUS_KEY]: {
        phase: 'downloading',
        targetVersion: release.latestVersion,
        startedAt: new Date().toISOString(),
      },
    });
    const downloadId = await downloadFile({
      url: release.installer.url,
      filename: WINDOWS_DOWNLOAD_FILENAME,
      conflictAction: 'overwrite',
      saveAs: false,
    });
    const download = await waitForDownload(downloadId);

    elements.updateDetail.textContent = `安装器下载完成，正在校验 SHA-256 并准备静默安装 ${release.latestVersion}…`;
    elements.message.textContent = '正在由本地核心校验安装器并启动更新 / Verifying installer…';
    const prepared = await nativeRequest('prepare_update', {
      update: {
        installerPath: download.filename,
        expectedSha256: release.installer.sha256,
        targetVersion: release.latestVersion,
      },
    });
    await chrome.storage.local.set({
      [UPDATE_STATUS_KEY]: {
        phase: 'installing',
        targetVersion: release.latestVersion,
        startedAt: new Date().toISOString(),
        installRoot: prepared?.installRoot ?? null,
      },
    });
    elements.updateDetail.textContent = `正在后台安装 ${release.latestVersion}；GPTWork Core 会短暂断开并自动恢复`;
    elements.message.textContent = '更新已启动，请保持此弹窗打开；完成后扩展会自动重新加载 / Installing…';

    const updatedState = await waitForInstalledCore(release.latestVersion);
    await chrome.storage.local.set({
      [UPDATE_STATUS_KEY]: {
        phase: 'complete',
        targetVersion: release.latestVersion,
        completedAt: new Date().toISOString(),
        nativeVersion: updatedState?.nativeStatus?.version ?? null,
      },
    });
    elements.updateDetail.textContent = `已安装 ${release.latestVersion}，正在重新加载扩展…`;
    elements.message.textContent = '更新完成 / Update complete. Reloading extension…';
    await sleep(900);
    chrome.runtime.reload();
  } catch (error) {
    await chrome.storage.local.set({
      [UPDATE_STATUS_KEY]: {
        phase: 'error',
        targetVersion: latestRelease?.latestVersion ?? null,
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => {});
    elements.message.textContent = `更新失败 / Update failed: ${error.message}`;
    elements.updateDetail.textContent = '一键更新未完成；不会修改模型锁定配置，可重新检查更新后再试。';
  } finally {
    updateBusy = false;
    renderUpdate(latestRelease);
  }
}


elements.autoVerify.addEventListener('click', () => {
  elements.message.textContent = '正在自动验证；证据不足会自动跟踪后续流并重试一次 / Auto verification is running…';
  elements.autoVerify.disabled = true;
  void sendMessage({ type: 'GPTLOCK_AUTO_VERIFY' })
    .then(async (result) => {
      await load();
      if (result.outcome === 'verified') {
        elements.message.textContent = `自动验证通过；共尝试 ${result.attempts} 次 / Verified.`;
      } else if (result.outcome === 'model_verified_reasoning_unconfirmed') {
        elements.message.textContent = `模型已确认 ${result.responseModel || result.requestModel || ''}；已自动重试 ${result.retries} 次，但服务端未暴露推理强度。`;
      } else {
        elements.message.textContent = `自动验证未完全确认：${result.reason || 'metadata_incomplete'}；已自动尝试 ${result.attempts} 次，请求锁定=${result.requestLockConfirmed ? '成功' : '未确认'}。`;
      }
    })
    .catch((error) => { elements.message.textContent = `自动验证失败 / Auto verification failed: ${error.message}`; })
    .finally(() => { elements.autoVerify.disabled = false; });
});

elements.reconnect.addEventListener('click', () => {
  elements.message.textContent = '重新连接中 / Reconnecting…';
  void sendMessage({ type: 'GPTLOCK_RECONNECT' })
    .then(() => load())
    .then(() => { elements.message.textContent = '连接检查完成 / Reconnect completed.'; })
    .catch((error) => { elements.message.textContent = error.message; });
});

elements.checkUpdate.addEventListener('click', () => {
  void checkUpdate().catch(() => {});
});

elements.installUpdate.addEventListener('click', () => {
  void installUpdate();
});

elements.installCore.addEventListener('click', () => {
  void chrome.tabs.create({ url: RELEASES_URL }).then(() => window.close());
});

elements.options.addEventListener('click', () => {
  void sendMessage({ type: 'GPTLOCK_OPEN_OPTIONS' }).then(() => window.close());
});

elements.logs.addEventListener('click', () => {
  void sendMessage({ type: 'GPTLOCK_OPEN_DIAGNOSTICS' }).then(() => window.close());
});

void Promise.all([load(), getPlatformInfo().then((info) => { platform = info; renderUpdate(); })]).catch((error) => {
  elements.guardTitle.textContent = '读取失败 / Failed to load';
  elements.guardDetail.textContent = error.message;
  elements.verdict.textContent = '错误';
  elements.verdict.className = 'verdict bad';
});