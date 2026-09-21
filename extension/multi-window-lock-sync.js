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
  let lastRequestedKey = '';

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

  function activeComposerSurface() {
    const composer = [
      document.querySelector('#prompt-textarea'),
      document.querySelector('textarea[data-testid*="prompt"]'),
      document.querySelector('[contenteditable="true"][data-testid*="composer"]'),
      document.querySelector('.ProseMirror[contenteditable="true"]'),
    ].find((element) => element && visible(element));
    if (!composer) return null;
    const form = composer.closest?.('form');
    if (form && visible(form)) return form;
    const testRoot = composer.closest?.('[data-testid*="composer"]');
    if (testRoot && visible(testRoot)) return testRoot;
    return composer.parentElement || null;
  }

  function ownedTrigger(selectors) {
    const composer = activeComposerSurface();
    if (!composer) return null;
    const matches = selectors.flatMap((selector) => [...composer.querySelectorAll(selector)]).filter(visible);
    return matches.length === 1 ? matches[0] : null;
  }

  function menuCandidates(scope = document) {
    return [...scope.querySelectorAll([
      '[role="menu"] [role="menuitem"]',
      '[role="listbox"] [role="option"]',
      '[data-radix-menu-content] [role="menuitem"]',
    ].join(','))].filter(visible);
  }

  async function chooseExact(selectors, desired, normalize) {
    // Single mutation authority: multi-window sync may only start from a unique
    // control owned by the active composer. Sidebar/history controls can never enter
    // this candidate set, even if ChatGPT reuses matching aria/testid semantics.
    const trigger = ownedTrigger(selectors);
    if (!trigger) return { changed: false, retry: true, reason: 'trigger_not_ready' };
    trigger.click();
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    const candidate = menuCandidates().find((element) =>
      elementTexts(element).some((text) => normalize(text) === desired)
      && !element.closest?.('[data-testid^="history-item-"]')
      && !element.closest?.('nav,aside'),
    );
    if (!candidate) {
      document.body?.click?.();
      // A locked model can legitimately be unavailable in the current ChatGPT
      // product/picker. Reopening the picker cannot make it appear and caused an
      // unsolicited click loop. Stop until configuration or navigation changes.
      return { changed: false, retry: false, unavailable: true, reason: 'target_not_in_picker' };
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
    // v0.5.108: no page-wide wake observer. A missing composer control receives the
    // bounded active retries above; an unavailable target waits for an explicit
    // policy/feature/navigation change instead of clicking on every DOM mutation.
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
    // Verification owns model-picker mutation while its transaction is active.
    // Ordinary cross-window alignment waits rather than competing for the same UI.
    if (document.documentElement?.dataset?.gptworkAutoVerification === 'running') {
      scheduleRetry();
      return;
    }
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
      else finishSync();
    } finally {
      syncing = false;
    }
  }

  function scheduleRetry(delay = RETRY_MS) {
    if (!pending) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => void alignNow(), delay);
  }

  function alignmentKey() {
    return JSON.stringify({
      enabled: featureEnabled,
      model: normalizeModel(policy?.lockedModels?.[0]),
      reasoning: normalizeReasoning(desiredReasoning()),
    });
  }

  function requestForcedSync({ resetAttempts = true, allowRepeat = false } = {}) {
    if (!featureEnabled) {
      finishSync();
      return;
    }
    const key = alignmentKey();
    if (!allowRepeat && key === lastRequestedKey) return;
    lastRequestedKey = key;
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
    if (changes.policy || changes.settings || changes.gptworkModelLockSelection) {
      refreshTabConfiguration({ forceSync: true });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshTabConfiguration({ forceSync: pending });
  });
  const navigationSync = () => {
    lastRequestedKey = '';
    refreshTabConfiguration({ forceSync: featureEnabled });
  };
  window.addEventListener('popstate', navigationSync);
  window.addEventListener('hashchange', navigationSync);

  refreshTabConfiguration({ forceSync: false });
})();
