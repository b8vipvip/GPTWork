import { normalizeConcreteModelId } from './policy.js';

const WORK_MODE_KEY = 'gptworkWorkModeEnabled';
const MODEL_LOCK_KEY = 'gptworkModelLockEnabled';
const MODEL_SELECTION_KEY = 'gptworkModelLockSelection';
const BASE_WORK_MODELS = Object.freeze(['gpt-6-astra', 'gpt-5.6-sol']);
const STORAGE_TIMEOUT_MS = 5000;

const workToggle = document.getElementById('workModeEnabled');
const modelToggle = document.getElementById('modelLockEnabled');
const legacyToggle = document.getElementById('enabled');
const message = document.getElementById('message') || document.getElementById('formMessage');
const customModels = document.getElementById('customModels');
const saveCustomModels = document.getElementById('saveCustomModels');
const customModelsMessage = document.getElementById('customModelsMessage');

let busy = false;
let currentAccount = { authenticated: false, entitlement: { active: false } };
let renderTimers = [];

function withTimeout(promise, ms = STORAGE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('操作超时，请重试 / Operation timed out')), ms)),
  ]);
}

function runtimeMessage(payload) {
  const messagePayload = typeof payload === 'string' ? { type: payload } : payload;
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(messagePayload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      if (!response?.ok) {
        const requestError = new Error(response?.error || 'Extension request failed');
        requestError.code = response?.code || null;
        return reject(requestError);
      }
      resolve(response.data);
    });
  });
}

function localGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (stored) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(stored || {});
    });
  });
}

function localSet(patch) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(patch, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function syncGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (stored) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(stored || {});
    });
  });
}

function syncSet(patch) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(patch, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function showMessage(text, tone = '') {
  if (!message) return;
  message.textContent = text || '';
  if ('className' in message) {
    message.className = tone === 'bad' ? 'inline-message bad' : tone === 'good' ? 'inline-message good' : '';
  }
}

function normalizeModels(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeConcreteModelId)
    .filter(Boolean))];
}

function isAtLeastSol(model) {
  const normalized = normalizeConcreteModelId(model);
  if (!normalized) return false;
  if (normalized === 'gpt-6-astra' || normalized === 'gpt-5.6-sol') return true;
  const match = normalized.match(/^gpt-(\d+)(?:[.-](\d+))?/i);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] || 0);
  return major > 5 || (major === 5 && minor >= 6);
}

function activationAllowed(account = currentAccount) {
  return Boolean(account?.authenticated && account?.entitlement?.active);
}

function promptAuthentication(text = '请先登录或注册 GPTWork 后再启用此功能。') {
  showMessage(text, 'bad');
  window.dispatchEvent(new CustomEvent('gptlock-auth-required', { detail: { message: text } }));
}

function requireActivation(account = currentAccount) {
  if (!account?.authenticated) {
    promptAuthentication();
    throw Object.assign(new Error('请先登录或注册 GPTWork'), { code: 'AUTH_REQUIRED' });
  }
  if (!account?.entitlement?.active) {
    const text = '当前使用时长已到期，请签到、分享或升级后再启用此功能。';
    showMessage(text, 'bad');
    throw Object.assign(new Error(text), { code: 'ENTITLEMENT_REQUIRED' });
  }
}

async function featureFlags() {
  const stored = await withTimeout(localGet([WORK_MODE_KEY, MODEL_LOCK_KEY]));
  return {
    workModeEnabled: stored[WORK_MODE_KEY] === true,
    modelLockEnabled: stored[MODEL_LOCK_KEY] === true,
    workDefined: typeof stored[WORK_MODE_KEY] === 'boolean',
    modelDefined: typeof stored[MODEL_LOCK_KEY] === 'boolean',
  };
}

async function configuredModels(fallback = []) {
  const stored = await withTimeout(syncGet([MODEL_SELECTION_KEY]));
  const selected = normalizeModels(stored[MODEL_SELECTION_KEY]);
  return selected.length ? selected : normalizeModels(fallback);
}

async function workModels() {
  const stored = await withTimeout(syncGet(['discoveredModels'])).catch(() => ({}));
  const discovered = normalizeModels(stored.discoveredModels).filter(isAtLeastSol);
  return [...new Set([...BASE_WORK_MODELS, ...discovered])];
}

async function activeModels(flags, fallbackPolicyModels = []) {
  const active = [];
  if (flags.workModeEnabled) active.push(...await workModels());
  if (flags.modelLockEnabled) active.push(...await configuredModels(fallbackPolicyModels));
  return [...new Set(active)];
}

async function applyActivePolicy(flags, fallbackPolicy = null) {
  if (!flags.workModeEnabled && !flags.modelLockEnabled) return;
  const stored = await withTimeout(syncGet(['policy']));
  const policy = stored.policy && typeof stored.policy === 'object'
    ? stored.policy
    : (fallbackPolicy || {});
  const lockedModels = await activeModels(flags, policy.lockedModels || fallbackPolicy?.lockedModels || []);
  if (!lockedModels.length) throw new Error('至少保留一个锁定模型 / Keep at least one locked model.');
  if (JSON.stringify(normalizeModels(policy.lockedModels)) === JSON.stringify(lockedModels)) return;
  await withTimeout(syncSet({ policy: { ...policy, lockedModels } }));
}

function syncVisibleToggles(flags) {
  if (workToggle) workToggle.checked = Boolean(flags.workModeEnabled);
  if (modelToggle) modelToggle.checked = Boolean(flags.modelLockEnabled);
  if (legacyToggle) legacyToggle.checked = Boolean(flags.workModeEnabled || flags.modelLockEnabled);
}

function setBusy(value) {
  busy = Boolean(value);
  if (workToggle) workToggle.disabled = busy;
  if (modelToggle) modelToggle.disabled = busy;
}

function selectedModelInputs() {
  return [...document.querySelectorAll('input[name="model"]:checked')]
    .map((input) => normalizeConcreteModelId(input.value))
    .filter(Boolean);
}

async function renderConfiguredModels() {
  if (!document.querySelector('input[name="model"]')) return;
  const state = await runtimeMessage('GPTLOCK_GET_STATE').catch(() => null);
  const selected = await configuredModels(state?.policy?.lockedModels || []);
  for (const input of document.querySelectorAll('input[name="model"]')) {
    input.checked = selected.includes(normalizeConcreteModelId(input.value));
  }
}

function scheduleConfiguredModelRender() {
  for (const timer of renderTimers) clearTimeout(timer);
  renderTimers = [50, 250, 700].map((delay) => setTimeout(() => void renderConfiguredModels().catch(() => {}), delay));
}

async function persistModelSelection(changedInput = null) {
  requireActivation();
  let models = [...new Set(selectedModelInputs())];
  if (!models.length) {
    if (changedInput) changedInput.checked = true;
    models = [...new Set(selectedModelInputs())];
    throw new Error('至少保留一个锁定模型 / Keep at least one locked model.');
  }
  await withTimeout(syncSet({ [MODEL_SELECTION_KEY]: models }));
  const flags = await featureFlags();
  if (flags.modelLockEnabled || flags.workModeEnabled) await applyActivePolicy(flags);
  showMessage('锁定模型列表已保存 / Model list saved.', 'good');
}

function renderCustomChoice(model) {
  const normalized = normalizeConcreteModelId(model);
  if (!normalized) return null;
  const existing = [...document.querySelectorAll('input[name="model"]')].find((input) => input.value === normalized);
  if (existing) {
    existing.checked = true;
    return existing;
  }
  const container = document.getElementById('modelChoices');
  if (!container) return null;
  const row = document.createElement('label');
  row.className = 'check-row';
  row.dataset.customModel = normalized;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = 'model';
  input.value = normalized;
  input.checked = true;
  const copy = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = normalized;
  const small = document.createElement('small');
  small.textContent = `${normalized} · 自定义 / Custom`;
  copy.append(strong, small);
  row.append(input, copy);
  container.append(row);
  return input;
}

async function addCustomModels() {
  requireActivation();
  const raw = String(customModels?.value || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const normalized = raw.map(normalizeConcreteModelId);
  const invalid = raw.filter((_, index) => !normalized[index]);
  if (invalid.length) throw new Error(`模型标识格式无效：${invalid.join(', ')}`);
  if (!normalized.length) throw new Error('请输入至少一个具体模型 ID。');
  for (const model of normalized) renderCustomChoice(model);
  await persistModelSelection();
  if (customModels) customModels.value = '';
  if (customModelsMessage) {
    customModelsMessage.textContent = `已添加：${[...new Set(normalized)].join(', ')} / Added.`;
    customModelsMessage.className = 'inline-message good';
  }
}

async function reconcile({ migrateLegacy = true } = {}) {
  const state = await withTimeout(runtimeMessage('GPTLOCK_GET_STATE'));
  currentAccount = state?.account || { authenticated: false, entitlement: { active: false } };
  let flags = await featureFlags();

  if (migrateLegacy && (!flags.workDefined || !flags.modelDefined)) {
    // Preserve an existing authenticated user's old master switch as Model lock.
    // Fresh/unauthenticated installs stay fully inert.
    const legacyWasEnabled = Boolean(state?.settings?.enabled);
    const migrated = {
      [WORK_MODE_KEY]: flags.workDefined ? flags.workModeEnabled : false,
      [MODEL_LOCK_KEY]: flags.modelDefined
        ? flags.modelLockEnabled
        : Boolean(legacyWasEnabled && activationAllowed(currentAccount)),
    };
    await withTimeout(localSet(migrated));
    flags = await featureFlags();
  }

  if (!activationAllowed(currentAccount) && (flags.workModeEnabled || flags.modelLockEnabled)) {
    await withTimeout(localSet({ [WORK_MODE_KEY]: false, [MODEL_LOCK_KEY]: false }));
    flags = await featureFlags();
  }

  const desiredGlobal = Boolean(flags.workModeEnabled || flags.modelLockEnabled);
  if (desiredGlobal) {
    await applyActivePolicy(flags, state?.policy || null);
  }
  if (Boolean(state?.settings?.enabled) !== desiredGlobal) {
    await withTimeout(runtimeMessage({ type: 'GPTLOCK_SET_ENABLED', enabled: desiredGlobal }));
  }
  syncVisibleToggles(flags);
  scheduleConfiguredModelRender();
  return { state, flags };
}

async function changeFeature(kind, desired) {
  if (busy) return;
  const key = kind === 'work' ? WORK_MODE_KEY : MODEL_LOCK_KEY;
  const target = kind === 'work' ? workToggle : modelToggle;
  const previous = !desired;
  setBusy(true);
  try {
    const state = await withTimeout(runtimeMessage('GPTLOCK_GET_STATE'));
    currentAccount = state?.account || currentAccount;
    if (desired) requireActivation(currentAccount);

    // Important: feature preference is written only after the account gate succeeds.
    // The legacy master key is never pre-written here, so a rejected enable cannot
    // produce a transient attach -> detach cycle.
    await withTimeout(localSet({ [key]: Boolean(desired) }));
    const flags = await featureFlags();
    if (flags.workModeEnabled || flags.modelLockEnabled) await applyActivePolicy(flags, state?.policy || null);
    await withTimeout(runtimeMessage({ type: 'GPTLOCK_SET_ENABLED', enabled: Boolean(flags.workModeEnabled || flags.modelLockEnabled) }));
    syncVisibleToggles(flags);
    showMessage(desired
      ? `${kind === 'work' ? 'Work 模式' : '模型锁定'}已启用。`
      : `${kind === 'work' ? 'Work 模式' : '模型锁定'}已关闭。`, 'good');
  } catch (error) {
    if (target) target.checked = previous;
    if (!['AUTH_REQUIRED', 'ENTITLEMENT_REQUIRED'].includes(error?.code)) {
      showMessage(`切换失败 / Toggle failed: ${error.message}`, 'bad');
    }
    await localSet({ [key]: previous }).catch(() => {});
    await reconcile({ migrateLegacy: false }).catch(() => {});
  } finally {
    setBusy(false);
  }
}

function bindFeatureToggle(toggle, kind) {
  if (!toggle) return;
  toggle.addEventListener('change', (event) => {
    event.stopImmediatePropagation();
    void changeFeature(kind, Boolean(toggle.checked));
  }, true);
}

bindFeatureToggle(workToggle, 'work');
bindFeatureToggle(modelToggle, 'model');

// The settings page's legacy options.js still renders model choices. Capture model
// selection before its old bubble handler so the visible list becomes configuration,
// while the active policy is derived from the two independent feature gates.
document.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.matches('input[name="model"]')) return;
  event.stopImmediatePropagation();
  const previous = !target.checked;
  void (async () => {
    try {
      const state = await runtimeMessage('GPTLOCK_GET_STATE');
      currentAccount = state?.account || currentAccount;
      requireActivation(currentAccount);
      await persistModelSelection(target);
    } catch (error) {
      target.checked = previous;
      if (!['AUTH_REQUIRED', 'ENTITLEMENT_REQUIRED'].includes(error?.code)) showMessage(error.message, 'bad');
    }
  })();
}, true);

if (saveCustomModels) {
  saveCustomModels.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    void addCustomModels().catch((error) => {
      if (!['AUTH_REQUIRED', 'ENTITLEMENT_REQUIRED'].includes(error?.code)) showMessage(`添加失败 / Add failed: ${error.message}`, 'bad');
    });
  }, true);
}

window.addEventListener('gptlock-account-changed', () => {
  void reconcile({ migrateLegacy: false }).catch((error) => showMessage(error.message, 'bad'));
});
window.addEventListener('gptlock-account-refresh', () => {
  void reconcile({ migrateLegacy: false }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && (changes.policy || changes[MODEL_SELECTION_KEY] || changes.discoveredModels)) {
    scheduleConfiguredModelRender();
  }
  if (areaName === 'local' && (changes[WORK_MODE_KEY] || changes[MODEL_LOCK_KEY])) {
    void featureFlags().then(syncVisibleToggles).catch(() => {});
  }
});

void reconcile().catch((error) => {
  showMessage(`读取功能状态失败 / Failed to load feature state: ${error.message}`, 'bad');
  syncVisibleToggles({ workModeEnabled: false, modelLockEnabled: false });
});
