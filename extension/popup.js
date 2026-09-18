import { KNOWN_MODELS, REASONING_LEVELS, normalizeConcreteModelId, normalizePolicy, normalizeSettings } from './policy.js';
import { classifyNativeError, nativeHelp, RELEASES_URL } from './native-status.js';

const UPDATE_STATUS_KEY = 'gptlockUiUpdateStatus';
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
  updateRuntimeProgress: document.getElementById('updateRuntimeProgress'),
  updateRuntimeProgressTitle: document.getElementById('updateRuntimeProgressTitle'),
  updateRuntimeProgressDetail: document.getElementById('updateRuntimeProgressDetail'),
  updateRuntimeProgressBar: document.getElementById('updateRuntimeProgressBar'),
  popupLockedModels: document.getElementById('popupLockedModels'),
  editModelLock: document.getElementById('editModelLock'),
  popupLockEditor: document.getElementById('popupLockEditor'),
  popupModelChoices: document.getElementById('popupModelChoices'),
  popupPreferredReasoning: document.getElementById('popupPreferredReasoning'),
  popupLockMessage: document.getElementById('popupLockMessage'),
};

let lastState = null;
let updateStatus = null;

function lockModelLabel(id) {
  return KNOWN_MODELS.find((model) => model.id === id)?.label || id;
}

function popupModelIds(stored, policy) {
  return [...new Set([
    ...KNOWN_MODELS.map((model) => model.id),
    ...(Array.isArray(stored?.discoveredModels) ? stored.discoveredModels : []),
    ...policy.lockedModels,
  ].map(normalizeConcreteModelId).filter(Boolean))];
}

function renderPopupLockEditor(stored, policy, settings) {
  if (!elements.popupModelChoices || !elements.popupPreferredReasoning) return;
  elements.popupModelChoices.replaceChildren();
  for (const model of popupModelIds(stored, policy)) {
    const row = document.createElement('label');
    row.className = 'popup-lock-choice';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'popup-lock-model';
    input.value = model;
    input.checked = policy.lockedModels.includes(model);
    const label = document.createElement('span');
    label.textContent = lockModelLabel(model);
    row.append(input, label);
    elements.popupModelChoices.append(row);
  }
  elements.popupPreferredReasoning.replaceChildren();
  for (const level of REASONING_LEVELS) {
    const option = document.createElement('option');
    option.value = level.id;
    option.textContent = `${level.labelZh} / ${level.labelEn}`;
    elements.popupPreferredReasoning.append(option);
  }
  elements.popupPreferredReasoning.value = settings.preferredReasoning;
}

async function renderPopupLockSummary() {
  const stored = await chrome.storage.sync.get(['policy', 'settings', 'discoveredModels']);
  const policy = normalizePolicy(stored.policy);
  const settings = normalizeSettings(stored.settings);
  if (elements.popupLockedModels) {
    elements.popupLockedModels.textContent = policy.lockedModels
      .map((model) => `${lockModelLabel(model)} · ${settings.preferredReasoning}`)
      .join(' / ') || '—';
  }
  renderPopupLockEditor(stored, policy, settings);
}

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

function renderUpdateStatus(next = updateStatus) {
  updateStatus = next || updateStatus;
  const currentVersion = chrome.runtime.getManifest().version;
  elements.currentVersion.textContent = currentVersion;
  elements.installUpdate.hidden = true;
  const transientPhases = ['checking', 'downloading', 'verifying', 'quiescing', 'installing', 'reloading', 'recovering'];
  const showProgress = Boolean(updateStatus && (transientPhases.includes(updateStatus.phase) || updateStatus.phase === 'error'));
  if (elements.updateRuntimeProgress) elements.updateRuntimeProgress.hidden = !showProgress;
  if (showProgress) {
    const percent = Math.max(0, Math.min(100, Math.round(Number(updateStatus.percent) || 0)));
    if (elements.updateRuntimeProgressBar) elements.updateRuntimeProgressBar.value = percent;
    if (elements.updateRuntimeProgressTitle) {
      elements.updateRuntimeProgressTitle.textContent = updateStatus.phase === 'error'
        ? 'GPTWork 更新尚未完成 / Update incomplete'
        : `GPTWork 更新恢复中 ${percent}% / Updating`;
    }
    if (elements.updateRuntimeProgressDetail) {
      elements.updateRuntimeProgressDetail.textContent = updateStatus.message || '正在等待全部功能恢复正常…';
    }
  }
  if (!updateStatus) {
    elements.updateDetail.textContent = `当前版本 ${currentVersion}`;
    return;
  }
  const transient = transientPhases.includes(updateStatus.phase);
  if (transient) {
    elements.updateDetail.textContent = updateStatus.message || `GPTWork 更新进行中 ${updateStatus.percent || 0}%`;
    elements.message.textContent = updateStatus.message || elements.message.textContent;
  } else if (updateStatus.phase === 'complete') {
    elements.updateDetail.textContent = updateStatus.message || 'GPTWork 已全部恢复正常';
  } else if (updateStatus.phase === 'error') {
    elements.updateDetail.textContent = updateStatus.message || 'GPTWork 更新尚未全部完成';
  }
}

async function renderStoredUpdateStatus() {
  const stored = await chrome.storage.local.get(UPDATE_STATUS_KEY);
  renderUpdateStatus(stored[UPDATE_STATUS_KEY] || null);
}

function render(state) {
  lastState = state;
  renderUpdateStatus(updateStatus);
  elements.version.textContent = state.extensionVersion || '';
  elements.currentVersion.textContent = state.extensionVersion || chrome.runtime.getManifest().version;
  const native = state.nativeStatus ?? {};
  const enabled = state.settings?.enabled === true;
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
  renderUpdateStatus(updateStatus);
}

async function load() {
  render(await sendMessage({ type: 'GPTLOCK_GET_STATE' }));
  await renderStoredUpdateStatus();
}

elements.editModelLock?.addEventListener('click', () => {
  const open = elements.popupLockEditor?.hidden !== false;
  if (elements.popupLockEditor) elements.popupLockEditor.hidden = !open;
  elements.editModelLock.setAttribute('aria-expanded', String(open));
});

elements.popupModelChoices?.addEventListener('change', async () => {
  const selected = [...elements.popupModelChoices.querySelectorAll('input[name="popup-lock-model"]:checked')]
    .map((input) => normalizeConcreteModelId(input.value)).filter(Boolean);
  if (!selected.length) {
    if (elements.popupLockMessage) elements.popupLockMessage.textContent = '至少保留一个锁定模型。';
    await renderPopupLockSummary();
    return;
  }
  const stored = await chrome.storage.sync.get('policy');
  const policy = normalizePolicy(stored.policy);
  await chrome.storage.sync.set({ policy: normalizePolicy({ ...policy, lockedModels: selected }) });
  if (elements.popupLockMessage) elements.popupLockMessage.textContent = '锁定模型已保存。';
  await renderPopupLockSummary();
});

elements.popupPreferredReasoning?.addEventListener('change', async () => {
  const preferredReasoning = elements.popupPreferredReasoning.value;
  const stored = await chrome.storage.sync.get(['policy', 'settings']);
  const policy = normalizePolicy(stored.policy);
  const settings = normalizeSettings(stored.settings);
  const allowedReasoningLevels = policy.allowedReasoningLevels.includes(preferredReasoning)
    ? policy.allowedReasoningLevels
    : [...new Set([...policy.allowedReasoningLevels, preferredReasoning])];
  await chrome.storage.sync.set({
    policy: normalizePolicy({ ...policy, allowedReasoningLevels }),
    settings: normalizeSettings({ ...settings, preferredReasoning }),
  });
  if (elements.popupLockMessage) elements.popupLockMessage.textContent = '推理强度已保存。';
  await renderPopupLockSummary();
});

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
  // Update execution has one authority in the service worker. The popup only opens the
  // settings update center, which renders the persisted background progress.
  void sendMessage({ type: 'GPTLOCK_OPEN_OPTIONS' }).then(() => window.close());
});

elements.installCore.addEventListener('click', () => {
  elements.installCore.disabled = true;
  elements.message.textContent = '正在检查本机 Core；若已安装将自动重新加载 GPTWork… / Checking local Core…';
  void sendMessage({ type: 'GPTWORK_CORE_REPAIR' })
    .then((result) => {
      if (result?.installed) {
        elements.message.textContent = `检测到本地 Core${result.nativeVersion ? ` ${result.nativeVersion}` : ''}，正在重新加载 GPTWork 并自动恢复连接…`;
        setTimeout(() => window.close(), 120);
        return;
      }
      return chrome.tabs.create({ url: RELEASES_URL }).then(() => window.close());
    })
    .catch(() => chrome.tabs.create({ url: RELEASES_URL }).then(() => window.close()))
    .finally(() => { elements.installCore.disabled = false; });
});

elements.options.addEventListener('click', () => {
  void sendMessage({ type: 'GPTLOCK_OPEN_OPTIONS' }).then(() => window.close());
});

elements.logs.addEventListener('click', () => {
  void sendMessage({ type: 'GPTLOCK_OPEN_DIAGNOSTICS' }).then(() => window.close());
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[UPDATE_STATUS_KEY]?.newValue) {
    renderUpdateStatus(changes[UPDATE_STATUS_KEY].newValue);
  }
});

void renderPopupLockSummary().catch(() => {});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && (changes.policy || changes.settings || changes.discoveredModels)) {
    void renderPopupLockSummary().catch(() => {});
  }
});

void load().catch((error) => {
  elements.guardTitle.textContent = '读取失败 / Failed to load';
  elements.guardDetail.textContent = error.message;
  elements.verdict.textContent = '错误';
  elements.verdict.className = 'verdict bad';
});
