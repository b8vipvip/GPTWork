(() => {
  const MODEL_SELECTORS = [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[data-testid*="model-switcher"]',
    'button[aria-label*="model" i][aria-haspopup="menu"]',
    'button[aria-label*="模型"][aria-haspopup="menu"]',
  ];
  const REASONING_SELECTORS = [
    '[data-testid*="reasoning"] button',
    'button[data-testid*="reasoning"]',
    'button[data-testid*="thinking"]',
    'button[aria-label*="reasoning" i][aria-haspopup]',
    'button[aria-label*="thinking" i][aria-haspopup]',
    'button[aria-label*="推理"][aria-haspopup]',
    'button[aria-label*="思考"][aria-haspopup]',
  ];
  const GENERATING_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="停止"]',
  ];
  const MODEL_ALIASES = Object.freeze({
    'gpt-5.6-sol-wm': 'gpt-5.6-sol',
    'gpt-5-6': 'gpt-5.6-sol',
  });
  const RETRY_MS = 1200;
  const MAX_ACTIVE_ATTEMPTS = 12;

  let policy = null;
  let settings = null;
  let featureEnabled = false;
  let timer = null;
  let pending = false;
  let attempts = 0;
  let syncing = false;
  let wakeObserver = null;

  function visible(element) {
    if (!element?.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function elementTexts(element) {
    return [
      element?.textContent?.trim(),
      element?.getAttribute?.('aria-label')?.trim(),
      element?.getAttribute?.('title')?.trim(),
    ].filter(Boolean);
  }

  function normalizeModel(value) {
    const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!raw) return null;
    const sol = raw.match(/(?:^|[^a-z0-9])(?:gpt-)?(\d+(?:\.\d+)*)-sol(?:-wm)?(?:$|[^a-z0-9])/);
    if (sol) return `gpt-${sol[1]}-sol`;
    const explicit = raw.match(/(?:^|[^a-z0-9])gpt-?(\d+(?:\.\d+)*)(?=$|[^a-z0-9.])/);
    if (explicit) return `gpt-${explicit[1]}`;
    const canonical = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9._:-]{1,128}$/.test(canonical)) return null;
    return MODEL_ALIASES[canonical] ?? canonical;
  }

  function normalizeReasoning(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (/extra[\s_-]*high|xhigh|超高/.test(raw)) return 'extra-high';
    if (/\bhigh\b|高级|高$/.test(raw)) return 'high';
    if (/\bmedium\b|中级|中等|中$/.test(raw)) return 'medium';
    if (/\blow\b|低级|低$/.test(raw)) return 'low';
    return null;
  }

  function currentValue(selectors, normalize) {
    for (const selector of selectors) {
      const element = [...document.querySelectorAll(selector)].find(visible);
      if (!element) continue;
      for (const text of elementTexts(element)) {
        const value = normalize(text);
        if (value) return value;
      }
    }
    return null;
  }

  function menuCandidates() {
    return [...document.querySelectorAll([
      '[role="menu"] [role="menuitem"]',
      '[role="listbox"] [role="option"]',
      '[data-radix-menu-content] [role="menuitem"]',
    ].join(','))].filter(visible);
  }

  async function chooseExact(selectors, desired, normalize) {
    const trigger = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
    if (!trigger) return { changed: false, retry: true };
    trigger.click();
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    const candidate = menuCandidates().find((element) =>
      elementTexts(element).some((text) => normalize(text) === desired),
    );
    if (!candidate) {
      document.body?.click?.();
      return { changed: false, retry: true };
    }
    candidate.click();
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    return { changed: true, retry: false };
  }

  function desiredReasoning() {
    const allowed = Array.isArray(policy?.allowedReasoningLevels) ? policy.allowedReasoningLevels : [];
    return allowed.includes(settings?.preferredReasoning) ? settings.preferredReasoning : allowed[0] || null;
  }

  function disarmWakeObserver() {
    wakeObserver?.disconnect();
    wakeObserver = null;
  }

  function armWakeObserver() {
    if (!pending || wakeObserver || !document.documentElement) return;
    wakeObserver = new MutationObserver(() => {
      if (!pending) {
        disarmWakeObserver();
        return;
      }
      disarmWakeObserver();
      attempts = 0;
      scheduleRetry(250);
    });
    wakeObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'aria-selected', 'aria-checked', 'data-state', 'data-value', 'data-model', 'data-model-id'],
    });
  }

  function finishSync() {
    pending = false;
    attempts = 0;
    clearTimeout(timer);
    timer = null;
    disarmWakeObserver();
  }

  async function alignNow() {
    timer = null;
    if (syncing || !pending) return;
    if (!featureEnabled || settings?.enabled === false) {
      finishSync();
      return;
    }
    if (document.querySelector(GENERATING_SELECTORS.join(','))) {
      scheduleRetry();
      return;
    }

    syncing = true;
    try {
      const desiredModel = normalizeModel(policy?.lockedModels?.[0]);
      const preferred = normalizeReasoning(desiredReasoning());
      let retry = false;
      const currentModel = currentValue(MODEL_SELECTORS, normalizeModel);
      if (desiredModel && currentModel !== desiredModel) {
        const result = await chooseExact(MODEL_SELECTORS, desiredModel, normalizeModel);
        retry ||= result.retry;
      }
      const currentReasoning = currentValue(REASONING_SELECTORS, normalizeReasoning);
      if (preferred && currentReasoning !== preferred) {
        const result = await chooseExact(REASONING_SELECTORS, preferred, normalizeReasoning);
        retry ||= result.retry;
      }
      const finalModel = currentValue(MODEL_SELECTORS, normalizeModel);
      const finalReasoning = currentValue(REASONING_SELECTORS, normalizeReasoning);
      const modelAligned = !desiredModel || finalModel === desiredModel;
      const reasoningAligned = !preferred || finalReasoning === preferred;
      if (modelAligned && reasoningAligned) {
        finishSync();
        window.dispatchEvent(new CustomEvent('gptlock:lock-selection-synced', {
          detail: { model: finalModel, reasoning: finalReasoning },
        }));
        return;
      }
      attempts += 1;
      if (retry && attempts < MAX_ACTIVE_ATTEMPTS) scheduleRetry();
      else if (retry) armWakeObserver();
    } finally {
      syncing = false;
    }
  }

  function scheduleRetry(delay = RETRY_MS) {
    if (!pending) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => void alignNow(), delay);
  }

  function requestForcedSync({ resetAttempts = true } = {}) {
    if (!featureEnabled) {
      finishSync();
      return;
    }
    pending = true;
    if (resetAttempts) attempts = 0;
    disarmWakeObserver();
    clearTimeout(timer);
    timer = window.setTimeout(() => void alignNow(), 80);
  }

  function applySnapshot(snapshot, { forceSync = false } = {}) {
    if (!snapshot) return;
    policy = snapshot.policy || policy;
    settings = snapshot.settings || settings;
    const features = snapshot.featureState || {};
    featureEnabled = Boolean(
      (features.workModeEnabled || features.modelLockEnabled)
      && snapshot.masterEnabled !== false
      && snapshot.account?.authenticated === true
      && snapshot.account?.entitlement?.active === true
      && snapshot.accountWindowAllowed !== false,
    );
    if (featureEnabled && forceSync) requestForcedSync();
    else if (!featureEnabled) finishSync();
  }

  function refreshTabConfiguration({ forceSync = false } = {}) {
    chrome.runtime.sendMessage({ type: 'GPTWORK_TAB_FEATURE_GET' }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) return;
      applySnapshot(response.data, { forceSync });
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'GPTWORK_TAB_FEATURE_STATE') {
      policy = message.policy || policy;
      const features = message.featureState || {};
      featureEnabled = Boolean(features.workModeEnabled || features.modelLockEnabled);
      refreshTabConfiguration({ forceSync: true });
    }
    if (message?.type === 'GPTLOCK_GUARD_STATE') {
      settings = message.settings || settings;
      if (message.settings?.enabled === false) finishSync();
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    if (changes.policy || changes.settings || changes.discoveredModels || changes.gptworkModelLockSelection) {
      refreshTabConfiguration({ forceSync: true });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshTabConfiguration({ forceSync: pending || featureEnabled });
  });
  window.addEventListener('popstate', () => refreshTabConfiguration({ forceSync: pending || featureEnabled }));
  window.addEventListener('hashchange', () => refreshTabConfiguration({ forceSync: pending || featureEnabled }));

  refreshTabConfiguration({ forceSync: false });
})();
