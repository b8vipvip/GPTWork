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
  customModels: document.getElementById('customModels'),
  saveCustomModels: document.getElementById('saveCustomModels'),
  customModelsMessage: document.getElementById('customModelsMessage'),
  preferredReasoning: document.getElementById('preferredReasoning'),
  enabled: document.getElementById('enabled'),
  networkVerification: document.getElementById('networkVerification'),
  autoAlignSelection: document.getElementById('autoAlignSelection'),
  connectionBadge: document.getElementById('connectionBadge'),
  nativeStatus: document.getElementById('nativeStatus'),
  verificationStatus: document.getElementById('verificationStatus'),
  evidenceStatus: document.getElementById('evidenceStatus'),
  reconnect: document.getElementById('reconnect'),
  autoVerify: document.getElementById('autoVerify'),
  logs: document.getElementById('logs'),
  formMessage: document.getElementById('formMessage'),
  installHelp: document.getElementById('installHelp'),
  installTitle: document.getElementById('installTitle'),
  installDetail: document.getElementById('installDetail'),
  installCore: document.getElementById('installCore'),
};

const knownModelIds = new Set(KNOWN_MODELS.map((model) => model.id));
let writeQueue = Promise.resolve();
let applyingRemoteState = false;
let messageTimer = null;

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

function renderCustomChoice(model, checked = true) {
  const concrete = normalizeConcreteModelId(model);
  if (!concrete) return null;
  const input = checkbox(
    elements.modelChoices,
    'model',
    concrete,
    modelLabel(concrete),
    `${concrete} · 自定义 / Custom`,
    { customModel: concrete },
  );
  input.checked = checked;
  return input;
}

function parseCustomModels() {
  const raw = elements.customModels.value
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = raw.filter((value) => !normalizeModelId(value));
  const routingAliases = raw.filter((value) => normalizeModelId(value) && !normalizeConcreteModelId(value));
  const models = [...new Set(raw.map(normalizeConcreteModelId).filter(Boolean))];
  return { raw, invalid, routingAliases, models };
}

function validateCustomModels(parsed) {
  if (parsed.invalid.length) {
    throw new Error(`模型标识格式无效：${parsed.invalid.join(', ')}。请填写实际传输 model ID（不能包含空格）。`);
  }
  if (parsed.routingAliases.length) {
    throw new Error(`${parsed.routingAliases.join(', ')} 是自动路由标识，不是具体模型，不能加入锁定列表。`);
  }
  if (!parsed.models.length) throw new Error('请输入至少一个具体模型 ID。');
}

function concreteSelectedModels() {
  return selected('model').map(normalizeConcreteModelId).filter(Boolean);
}

function renderStatus(nativeStatus = {}) {
  const connected = Boolean(nativeStatus.connected);
  elements.connectionBadge.className = `badge ${connected ? 'online' : 'offline'}`;
  elements.connectionBadge.textContent = connected
    ? '本地核心已连接 / Core online'
    : '本地核心离线 / Core offline';
  elements.nativeStatus.textContent = connected
    ? `已连接 / Connected${nativeStatus.policyRevision ? ` · ${nativeStatus.policyRevision}` : ''}`
    : `${nativeStatus.lastError || '未连接 / Not connected'} · 请求锁定器可独立运行`;
  elements.installHelp.hidden = connected;
  if (!connected) {
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
      if (!knownModelIds.has(model)) renderCustomChoice(model, true);
    }
    setSelected('model', policy.lockedModels);
    setSelected('reasoning', policy.allowedReasoningLevels);
    const mode = document.querySelector(`input[name="mode"][value="${policy.strictMode}"]`);
    if (mode) mode.checked = true;
    elements.preferredReasoning.value = settings.preferredReasoning;
    elements.enabled.checked = settings.enabled;
    elements.networkVerification.checked = settings.networkVerificationEnabled;
    elements.autoAlignSelection.checked = settings.autoAlignSelection;
    renderStatus(state.nativeStatus);
  } finally {
    applyingRemoteState = false;
  }
}

async function load() {
  const state = await sendMessage({ type: 'GPTLOCK_GET_STATE' });
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

async function addCustomModels() {
  const parsed = parseCustomModels();
  validateCustomModels(parsed);
  for (const model of parsed.models) renderCustomChoice(model, true);
  const lockedModels = [...new Set(concreteSelectedModels())];
  await patchPolicy({ lockedModels });
  elements.customModels.value = '';
  if (elements.customModelsMessage) {
    elements.customModelsMessage.textContent = `已添加：${parsed.models.join(', ')} / Added.`;
    elements.customModelsMessage.className = 'inline-message good';
  }
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
  if (target === elements.enabled) {
    void queueWrite(() => patchSettings({ enabled: target.checked })).catch(() => void load().catch(() => {}));
    return;
  }
  if (target === elements.networkVerification) {
    void queueWrite(() => patchSettings({ networkVerificationEnabled: target.checked })).catch(() => void load().catch(() => {}));
    return;
  }
  if (target === elements.autoAlignSelection) {
    void queueWrite(() => patchSettings({ autoAlignSelection: target.checked })).catch(() => void load().catch(() => {}));
  }
}

document.addEventListener('change', persistFromChange);

if (elements.saveCustomModels) {
  elements.saveCustomModels.addEventListener('click', () => {
    if (elements.customModelsMessage) elements.customModelsMessage.className = 'inline-message';
    elements.saveCustomModels.disabled = true;
    void queueWrite(addCustomModels)
      .catch((error) => {
        if (elements.customModelsMessage) {
          elements.customModelsMessage.textContent = `添加失败 / Add failed: ${error.message}`;
          elements.customModelsMessage.className = 'inline-message bad';
        }
      })
      .finally(() => {
        elements.saveCustomModels.disabled = false;
      });
  });
  elements.customModels.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    elements.saveCustomModels.click();
  });
}

elements.reconnect.addEventListener('click', () => {
  elements.nativeStatus.textContent = '重新连接中 / Reconnecting…';
  void sendMessage({ type: 'GPTLOCK_RECONNECT' })
    .then(load)
    .catch((error) => {
      elements.nativeStatus.textContent = `连接失败 / Failed: ${error.message}`;
    });
});

elements.autoVerify.addEventListener('click', () => {
  showMessage('正在自动对齐并发送可见测试消息 / Sending visible verification message…');
  elements.autoVerify.disabled = true;
  void sendMessage({ type: 'GPTLOCK_AUTO_VERIFY' })
    .then(async (result) => {
      await load();
      showMessage(result.sent
        ? '已自动发送可见测试消息；响应完成后自动确认 / Visible test sent automatically.'
        : `自动验证未发送 / Not sent · ${result.tabState?.guard?.reason || result.tabState?.guard?.status || 'unknown'}`,
      );
    })
    .catch((error) => showMessage(`自动验证失败 / Auto verification failed: ${error.message}`, 'bad'))
    .finally(() => {
      elements.autoVerify.disabled = false;
    });
});

elements.logs.addEventListener('click', () => {
  void sendMessage({ type: 'GPTLOCK_OPEN_DIAGNOSTICS' });
});

elements.installCore.addEventListener('click', () => {
  void chrome.tabs.create({ url: RELEASES_URL });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || (!changes.policy && !changes.settings)) return;
  window.setTimeout(() => void load().catch(() => {}), 0);
});

void load().catch((error) => {
  renderStatus({ connected: false, lastError: error.message });
});
