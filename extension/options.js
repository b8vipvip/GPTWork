import {
  KNOWN_MODELS,
  REASONING_LEVELS,
  normalizeConcreteModelId,
  normalizeModelId,
  normalizePolicy,
  normalizeSettings,
} from './policy.js';
import { classifyNativeError, nativeHelp, RELEASES_URL } from './native-status.js';

const elements = {
  extensionVersion: document.getElementById('extensionVersion'),
  modelChoices: document.getElementById('modelChoices'),
  reasoningChoices: document.getElementById('reasoningChoices'),
  preferredReasoning: document.getElementById('preferredReasoning'),
  lockedModelSummary: document.getElementById('lockedModelSummary'),
  reasoningSummary: document.getElementById('reasoningSummary'),
  lockEditorToggle: document.getElementById('lockEditorToggle'),
  lockEditor: document.getElementById('lockEditor'),
  enabled: document.getElementById('enabled'),
  networkVerification: document.getElementById('networkVerification'),
  autoAlignSelection: document.getElementById('autoAlignSelection'),
  connectionBadge: document.getElementById('connectionBadge'),
  nativeStatus: document.getElementById('nativeStatus'),
  verificationStatus: document.getElementById('verificationStatus'),
  evidenceStatus: document.getElementById('evidenceStatus'),
  reconnect: document.getElementById('reconnect'),
  autoVerify: document.getElementById('autoVerify'),
  autoVerifyProgress: document.getElementById('autoVerifyProgress'),
  autoVerifyProgressLabel: document.getElementById('autoVerifyProgressLabel'),
  autoVerifyProgressCount: document.getElementById('autoVerifyProgressCount'),
  autoVerifyProgressBar: document.getElementById('autoVerifyProgressBar'),
  logs: document.getElementById('logs'),
  formMessage: document.getElementById('formMessage'),
  installHelp: document.getElementById('installHelp'),
  installTitle: document.getElementById('installTitle'),
  installDetail: document.getElementById('installDetail'),
  installCore: document.getElementById('installCore'),
};

const UPDATE_STATUS_KEY = 'gptlockUiUpdateStatus';
const UPDATE_TRANSIENT_PHASES = new Set(['checking', 'downloading', 'verifying', 'quiescing', 'installing', 'reloading', 'recovering']);

const knownModelIds = new Set(KNOWN_MODELS.map((model) => model.id));
let writeQueue = Promise.resolve();
let applyingRemoteState = false;
let messageTimer = null;
let updateRecoveryActive = false;
let lastNativeStatus = null;
let autoVerifyPollTimer = null;

function checkbox(container, name, id, label, detail = '', dataset = {}) {
  const existing = [...container.querySelectorAll(`input[name="${name}"]`)]
    .find((input) => input.value === id);
  if (existing) return existing;

  const row = document.createElement('label');
  row.className = 'check-row';
  for (const [key, value] of Object.entries(dataset)) row.dataset[key] = value;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = name;
  input.value = id;
  const text = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = label;
  text.append(strong);
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    text.append(small);
  }
  row.append(input, text);
  container.append(row);
  return input;
}

function modelLabel(model) {
  const known = KNOWN_MODELS.find((item) => item.id === model);
  if (known) return known.label;
  return model;
}

for (const model of KNOWN_MODELS) checkbox(elements.modelChoices, 'model', model.id, model.label, model.id);
for (const level of REASONING_LEVELS) {
  checkbox(elements.reasoningChoices, 'reasoning', level.id, level.labelZh, level.labelEn);
  const option = document.createElement('option');
  option.value = level.id;
  option.textContent = `${level.labelZh} / ${level.labelEn}`;
  elements.preferredReasoning.append(option);
}

function selected(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

function setSelected(name, values) {
  for (const input of document.querySelectorAll(`input[name="${name}"]`)) {
    input.checked = values.includes(input.value);
  }
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

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (stored) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(stored || {});
    });
  });
}

function storageSet(patch) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(patch, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function showMessage(text, tone = 'good') {
  if (!elements.formMessage) return;
  clearTimeout(messageTimer);
  elements.formMessage.textContent = text;
  elements.formMessage.className = tone === 'bad' ? 'inline-message bad' : 'inline-message good';
  messageTimer = window.setTimeout(() => {
    elements.formMessage.textContent = '';
    elements.formMessage.className = '';
  }, 2400);
}

function queueWrite(task) {
  writeQueue = writeQueue
    .catch(() => {})
    .then(task)
    .then(() => showMessage('已即时同步 / Synced.'))
    .catch((error) => {
      showMessage(`同步失败 / Sync failed: ${error.message}`, 'bad');
      throw error;
    });
  return writeQueue;
}

async function patchPolicy(patch) {
  const stored = await storageGet('policy');
  const current = normalizePolicy(stored.policy);
  const next = normalizePolicy({ ...current, ...patch });
  await storageSet({ policy: next });
  return next;
}

async function patchSettings(patch) {
  const stored = await storageGet('settings');
  const current = normalizeSettings(stored.settings);
  const next = normalizeSettings({ ...current, ...patch });
  await storageSet({ settings: next });
  return next;
}

function renderDiscoveredChoice(model, checked = true) {
  const concrete = normalizeConcreteModelId(model);
  if (!concrete) return null;
  const input = checkbox(
    elements.modelChoices,
    'model',
    concrete,
    modelLabel(concrete),
    `${concrete} · 自动识别 / Auto discovered`,
    { discoveredModel: concrete },
  );
  input.checked = checked;
  return input;
}

function concreteSelectedModels() {
  return selected('model').map(normalizeConcreteModelId).filter(Boolean);
}

function renderLockSummary(policy, settings) {
  if (elements.lockedModelSummary) {
    elements.lockedModelSummary.textContent = policy.lockedModels.map(modelLabel).join(' / ') || '—';
  }
  if (elements.reasoningSummary) {
    const allowed = policy.allowedReasoningLevels.join(' / ');
    elements.reasoningSummary.textContent = `${settings.preferredReasoning}${allowed ? `（允许：${allowed}）` : ''}`;
  }
}

function renderAutoVerifyProgress(autoVerification = null) {
  if (!elements.autoVerifyProgress) return;
  const progress = autoVerification?.catalogVerification;
  const running = autoVerification?.running === true;
  const total = Math.max(0, Number(progress?.total || autoVerification?.maxAttempts || 0));
  const completed = Math.min(total, Math.max(0, Number(progress?.completed || 0)));
  const requestConfirmed = Math.max(0, Number(progress?.requestConfirmed || 0));
  const verified = Math.max(0, Number(progress?.verified || 0));
  const failed = Math.max(0, Number(progress?.failed || 0));
  const current = progress?.currentLabel || progress?.currentModel || null;

  elements.autoVerifyProgress.hidden = !running && !progress;
  if (elements.autoVerifyProgressBar) {
    elements.autoVerifyProgressBar.max = Math.max(1, total);
    elements.autoVerifyProgressBar.value = completed;
  }
  if (elements.autoVerifyProgressCount) {
    elements.autoVerifyProgressCount.textContent = total
      ? `执行进度 ${completed}/${total} · 验证成功 ${verified}/${total} · 请求确认 ${requestConfirmed}/${total}`
      : '发现中…';
  }
  if (elements.autoVerifyProgressLabel) {
    elements.autoVerifyProgressLabel.textContent = running
      ? current
        ? `正在验证：${modelLabel(current)}`
        : '正在发现当前账户可用模型…'
      : total
        ? `执行完成 ${completed}/${total} · 验证成功 ${verified}/${total} · 未确认 ${failed}`
        : '未发现可验证模型';
  }
}

function stopAutoVerifyPolling() {
  if (autoVerifyPollTimer !== null) window.clearInterval(autoVerifyPollTimer);
  autoVerifyPollTimer = null;
}

function startAutoVerifyPolling() {
  stopAutoVerifyPolling();
  autoVerifyPollTimer = window.setInterval(() => {
    void sendMessage({ type: 'GPTLOCK_GET_STATE' })
      .then((state) => renderAutoVerifyProgress(state?.tabState?.autoVerification))
      .catch(() => {});
  }, 500);
}

function renderStatus(nativeStatus = {}) {
  lastNativeStatus = nativeStatus || {};
  const connected = Boolean(nativeStatus.connected);
  const recovering = !connected && updateRecoveryActive;
  elements.connectionBadge.className = `badge ${connected ? 'online' : 'offline'}`;
  elements.connectionBadge.textContent = connected
    ? '本地核心已连接 / Core online'
    : recovering
      ? 'GPTWork 更新恢复中 / Recovering'
      : '本地核心离线 / Core offline';
  elements.nativeStatus.textContent = connected
    ? `已连接 / Connected${nativeStatus.policyRevision ? ` · ${nativeStatus.policyRevision}` : ''}`
    : recovering
      ? '更新尚未完成：正在恢复本地核心、页面运行时和请求锁定器 / Update recovery in progress'
      : `${nativeStatus.lastError || '未连接 / Not connected'} · 请求锁定器可独立运行`;
  elements.installHelp.hidden = connected || recovering;
  if (!connected && !recovering) {
    const help = nativeHelp(nativeStatus.errorCode || classifyNativeError(nativeStatus.lastError));
    elements.installTitle.textContent = help.title;
    elements.installDetail.textContent = `${help.detail} 本地核心离线不会把日常聊天卡死；扩展仍会尝试网络层请求锁定。`;
  }

  const verification = nativeStatus.lastVerification;
  if (!verification) {
    elements.verificationStatus.textContent = '暂无 / None';
    if (elements.evidenceStatus) elements.evidenceStatus.textContent = '暂无 / None';
    return;
  }
  const verdicts = {
    verified: '已验证 / Verified',
    mismatch: '不匹配 / Mismatch',
    unverified: '未验证 / Unverified',
  };
  elements.verificationStatus.textContent = `${verdicts[verification.verdict] || verification.verdict} · ${verification.decision}`;
  if (elements.evidenceStatus) elements.evidenceStatus.textContent = `${verification.evidenceSource} · ${verification.confidence}`;
}

async function applyState(state) {
  applyingRemoteState = true;
  try {
    elements.extensionVersion.textContent = state.extensionVersion || '';
    const policy = normalizePolicy(state.policy);
    const settings = normalizeSettings(state.settings);

    for (const model of policy.lockedModels) {
      if (!knownModelIds.has(model)) renderDiscoveredChoice(model, true);
    }
    setSelected('model', policy.lockedModels);
    setSelected('reasoning', policy.allowedReasoningLevels);
    const mode = document.querySelector(`input[name="mode"][value="${policy.strictMode}"]`);
    if (mode) mode.checked = true;
    elements.preferredReasoning.value = settings.preferredReasoning;
    renderLockSummary(policy, settings);
    // #enabled is local-only Master authority and is rendered exclusively by
    // master-ui-controller.js. Never repaint it from legacy/synced settings.enabled.
    // These controls were removed from settings-v0521.html when the settings UI was
    // simplified. Keep options.js compatible with pages that no longer render them:
    // a missing legacy checkbox must never abort applyState() before renderStatus().
    if (elements.networkVerification) {
      elements.networkVerification.checked = settings.networkVerificationEnabled;
    }
    if (elements.autoAlignSelection) {
      elements.autoAlignSelection.checked = settings.autoAlignSelection;
    }
    renderStatus(state.nativeStatus);
    renderAutoVerifyProgress(state.tabState?.autoVerification);
  } finally {
    applyingRemoteState = false;
  }
}

async function load() {
  const [state, stored] = await Promise.all([
    sendMessage({ type: 'GPTLOCK_GET_STATE' }),
    chrome.storage.local.get(UPDATE_STATUS_KEY),
  ]);
  updateRecoveryActive = UPDATE_TRANSIENT_PHASES.has(stored?.[UPDATE_STATUS_KEY]?.phase);
  await applyState(state);
}

async function persistModelSelection(changedInput) {
  const lockedModels = [...new Set(concreteSelectedModels())];
  if (!lockedModels.length) {
    changedInput.checked = true;
    throw new Error('至少保留一个锁定模型 / Keep at least one locked model.');
  }
  await patchPolicy({ lockedModels });
}

async function persistReasoningSelection(changedInput) {
  const levels = selected('reasoning');
  if (!levels.length) {
    changedInput.checked = true;
    throw new Error('至少保留一个推理强度 / Keep at least one reasoning level.');
  }

  const stored = await storageGet(['policy', 'settings']);
  const currentPolicy = normalizePolicy(stored.policy);
  const currentSettings = normalizeSettings(stored.settings);
  const preferredReasoning = levels.includes(currentSettings.preferredReasoning)
    ? currentSettings.preferredReasoning
    : levels[0];
  const policy = normalizePolicy({ ...currentPolicy, allowedReasoningLevels: levels });
  const settings = normalizeSettings({ ...currentSettings, preferredReasoning });
  await storageSet({ policy, settings });
  elements.preferredReasoning.value = preferredReasoning;
}

function persistFromChange(event) {
  if (applyingRemoteState) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;

  if (target.matches('input[name="model"]')) {
    void queueWrite(() => persistModelSelection(target)).catch(() => void load().catch(() => {}));
    return;
  }
  if (target.matches('input[name="reasoning"]')) {
    void queueWrite(() => persistReasoningSelection(target)).catch(() => void load().catch(() => {}));
    return;
  }
  if (target.matches('input[name="mode"]')) {
    const strictMode = target.value === 'true';
    void queueWrite(() => patchPolicy({ strictMode })).catch(() => void load().catch(() => {}));
    return;
  }
  if (target === elements.preferredReasoning) {
    const preferredReasoning = target.value;
    if (!selected('reasoning').includes(preferredReasoning)) {
      void load().catch(() => {});
      showMessage('优先推理强度必须位于允许列表中 / Preferred reasoning must be allowed.', 'bad');
      return;
    }
    void queueWrite(() => patchSettings({ preferredReasoning })).catch(() => void load().catch(() => {}));
    return;
  }
  // #enabled is owned exclusively by master-ui-controller.js. Its capture-phase
  // listener stops propagation before this generic settings delegate, so do not
  // mirror the Master switch into sync settings or create a second writer here.
  if (target === elements.enabled) return;
  if (target === elements.networkVerification) {
    void queueWrite(() => patchSettings({ networkVerificationEnabled: target.checked })).catch(() => void load().catch(() => {}));
    return;
  }
  if (target === elements.autoAlignSelection) {
    void queueWrite(() => patchSettings({ autoAlignSelection: target.checked })).catch(() => void load().catch(() => {}));
  }
}

document.addEventListener('change', persistFromChange);

elements.lockEditorToggle?.addEventListener('click', () => {
  const open = elements.lockEditor?.hidden !== false;
  if (elements.lockEditor) elements.lockEditor.hidden = !open;
  elements.lockEditorToggle.setAttribute('aria-expanded', String(open));
});

elements.reconnect?.addEventListener('click', () => {
  elements.nativeStatus.textContent = '重新连接中 / Reconnecting…';
  void sendMessage({ type: 'GPTLOCK_RECONNECT' })
    .then(load)
    .catch((error) => {
      elements.nativeStatus.textContent = `连接失败 / Failed: ${error.message}`;
    });
});

elements.autoVerify?.addEventListener('click', () => {
  showMessage('正在发现账户模型并逐一验证 / Discovering and verifying account models…');
  elements.autoVerify.disabled = true;
  renderAutoVerifyProgress({ running: true, maxAttempts: 0, catalogVerification: null });
  startAutoVerifyPolling();
  void sendMessage({ type: 'GPTLOCK_AUTO_VERIFY' })
    .then(async (result) => {
      await load();
      showMessage(result.catalogTotal
        ? `自动验证完成：执行 ${result.catalogTotal}/${result.catalogTotal}；验证成功 ${result.catalogVerified}/${result.catalogTotal}；请求确认 ${result.catalogRequestConfirmed || 0}/${result.catalogTotal}`
        : `自动验证未发现模型 / No account models discovered · ${result.reason || 'unknown'}`,
        result.catalogFailed || !result.catalogTotal ? 'bad' : 'good',
      );
    })
    .catch((error) => showMessage(`自动验证失败 / Auto verification failed: ${error.message}`, 'bad'))
    .finally(() => {
      stopAutoVerifyPolling();
      elements.autoVerify.disabled = false;
    });
});

elements.logs?.addEventListener('click', () => {
  void sendMessage({ type: 'GPTLOCK_OPEN_DIAGNOSTICS' });
});

elements.installCore?.addEventListener('click', () => {
  void chrome.tabs.create({ url: RELEASES_URL });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes[UPDATE_STATUS_KEY]) {
      updateRecoveryActive = UPDATE_TRANSIENT_PHASES.has(changes[UPDATE_STATUS_KEY].newValue?.phase);
      renderStatus(lastNativeStatus || {});
    }
    if (changes.nativeStatus?.newValue) renderStatus(changes.nativeStatus.newValue);
    return;
  }
  if (areaName === 'sync' && (changes.policy || changes.settings)) {
    window.setTimeout(() => void load().catch(() => {}), 0);
  }
});

window.addEventListener('focus', () => void load().catch(() => {}));
window.addEventListener('pageshow', () => void load().catch(() => {}));

void load().catch((error) => {
  renderStatus({ connected: false, lastError: error.message });
});
