(() => {
  const MODEL_SELECTORS = [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[data-testid*="model-switcher"]',
    'button[aria-label*="model" i][aria-haspopup="menu"]',
    'button[aria-label*="模型"][aria-haspopup="menu"]',
    'button.__composer-pill[aria-haspopup="menu"]',
    'button[class*="__composer-pill"][aria-haspopup="menu"]',
    'button[aria-haspopup="menu"][data-tone="neutral"]',
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
  const COMPOSER_SELECTORS = [
    '#prompt-textarea',
    'textarea[data-testid*="prompt"]',
    '[contenteditable="true"][data-testid*="composer"]',
    '.ProseMirror[contenteditable="true"]',
  ];
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-submit-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="发送提示"]',
    'button[aria-label="发送消息"]',
  ];
  const GENERATING_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="停止"]',
  ];
  const AUTO_PROBE_TEXT = 'GPTWork 自动验证测试：请只回复“验证完成”。';
  const BLOCKING_GUARD_HEARTBEAT_MS = 1500;
  const BLOCKING_GUARD_MAX_AGE_MS = 4500;

  let reportTimer = null;
  let alignTimer = null;
  let previousFingerprint = '';
  let cachedState = null;
  let cachedPolicy = null;
  let cachedSettings = null;
  let lastUrl = location.href;
  let lastAlignAttempt = '';
  let lastAlignAt = 0;
  let sendConsumedAt = 0;
  let indicator = null;
  let autoProbeRunning = false;
  let lastRuntimeContactAt = Date.now();

  function elementTexts(element) {
    return [
      element?.textContent?.trim(),
      element?.getAttribute?.('aria-label')?.trim(),
      element?.getAttribute?.('title')?.trim(),
    ].filter(Boolean);
  }

  function firstNormalized(selectors, normalize) {
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        for (const text of elementTexts(element)) {
          const value = normalize(text);
          if (value) return value;
        }
      }
    }
    return null;
  }

  function firstNormalizedElements(elements, normalize) {
    for (const element of elements) {
      for (const text of elementTexts(element)) {
        const value = normalize(text);
        if (value) return value;
      }
    }
    return null;
  }

  function composerNearbyControls() {
    const composer = COMPOSER_SELECTORS.map((selector) => document.querySelector(selector)).find((element) => element && visible(element));
    if (!composer) return [];
    const composerRect = composer.getBoundingClientRect();
    return [...document.querySelectorAll('button,[role="button"],[aria-haspopup]')].filter((element) => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom >= composerRect.top - 96 && rect.top <= composerRect.bottom + 96;
    });
  }

  function normalizeDisplayedModel(text) {
    if (!text) return null;
    const compact = text.trim().toLowerCase().replace(/\s+/g, '-');
    const explicit = compact.match(/gpt-?(\d+(?:\.\d+)*)(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?/);
    if (explicit) {
      const suffix = explicit[2] ? `-${explicit[2]}` : '';
      const value = `gpt-${explicit[1]}${suffix}`;
      return value === 'gpt-5.6-sol-wm' ? 'gpt-5.6-sol' : value;
    }
    const compactSol = compact.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)*)-sol(?:-wm)?(?:-|$)/);
    if (compactSol) return `gpt-${compactSol[1]}-sol`;
    return null;
  }

  function normalizeDisplayedReasoning(text) {
    if (!text) return null;
    const value = text.trim().toLowerCase();
    if (/extra[\s_-]*high|xhigh|超高/.test(value)) return 'extra-high';
    if (/\bhigh\b|高级|高$/.test(value)) return 'high';
    if (/\bmedium\b|中级|中$/.test(value)) return 'medium';
    if (/\blow\b|低级|低$/.test(value)) return 'low';
    return null;
  }

  function collectObservation() {
    const validated = globalThis.__GPTLOCK_PAGE_MODEL_EVIDENCE__?.collect?.();
    if (validated) {
      return {
        model: validated.model || null,
        reasoning: validated.reasoning || null,
        evidenceSource: 'page_dom',
        modelEvidenceSource: validated.modelSource || 'none',
        reasoningEvidenceSource: validated.reasoningSource || 'none',
        modelLabel: validated.modelLabel || '',
        reasoningLabel: validated.reasoningLabel || '',
        ambiguousModel: Boolean(validated.ambiguous),
        candidates: Array.isArray(validated.candidates) ? validated.candidates.slice(0, 8) : [],
        capturedAt: new Date().toISOString(),
      };
    }

    const nearbyControls = composerNearbyControls();
    const model = firstNormalized(MODEL_SELECTORS, normalizeDisplayedModel)
      || firstNormalizedElements(nearbyControls, normalizeDisplayedModel)
      || firstNormalized(['button,[role="button"]'], normalizeDisplayedModel);
    const reasoning = firstNormalized(REASONING_SELECTORS, normalizeDisplayedReasoning)
      || firstNormalizedElements(nearbyControls, normalizeDisplayedReasoning)
      || firstNormalized(MODEL_SELECTORS, normalizeDisplayedReasoning)
      || (model ? firstNormalized(['button,[role="button"]'], normalizeDisplayedReasoning) : null);
    return {
      model,
      reasoning,
      evidenceSource: 'page_dom',
      modelEvidenceSource: 'legacy-fallback',
      reasoningEvidenceSource: 'legacy-fallback',
      ambiguousModel: false,
      candidates: model ? [model] : [],
      capturedAt: new Date().toISOString(),
    };
  }

  function runtimeContextAvailable() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            lastRuntimeContactAt = 0;
            reject(new Error(error.message));
          } else if (!response?.ok) {
            lastRuntimeContactAt = Date.now();
            reject(new Error(response?.error || 'Extension request failed'));
          } else {
            lastRuntimeContactAt = Date.now();
            resolve(response.data);
          }
        });
      } catch (error) {
        lastRuntimeContactAt = 0;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function reasonText(guard) {
    const messages = {
      waiting_for_response_metadata: '请求已锁定，正在等待响应确认 / Request locked; waiting for response metadata',
      page_selection_not_allowed: '页面选择与策略不同；正式请求仍会尝试锁定 / UI differs; the formal request will still be locked',
      page_selection_missing: '页面未暴露完整选择；网络请求锁仍已就绪 / UI selection is incomplete; network request lock remains ready',
      response_verification_disabled: '响应确认已关闭；请求锁定仍启用 / Response verification is off; request locking remains active',
      network_monitor_not_attached: '请求锁定器未连接；聊天不会因此被阻断 / Request lock is not attached; chat remains fail-open',
      native_core_offline: '本地核心离线；请求锁定仍由扩展尝试执行 / Native Core is offline; extension request locking remains active',
      metadata_missing: '响应确认元数据不完整；不会因此阻断聊天 / Response metadata is incomplete; chat remains available',
      model_missing: '响应未暴露可验证模型字段 / Response did not expose a verifiable model field',
      reasoning_missing: '响应未暴露可验证推理强度字段 / Response did not expose a verifiable reasoning field',
      model_not_allowed: '响应确认模型与锁定策略不一致 / Confirmed response model mismatches the lock policy',
      reasoning_not_allowed: '响应推理强度与策略不一致；仅告警 / Response reasoning mismatches policy; warning only',
      evidence_source_insufficient: '证据来源不足 / Evidence source is insufficient',
      evidence_stale: '响应证据已过期 / Response evidence is stale',
      gptlock_disabled: 'GPTWork 已关闭 / GPTWork is disabled',
      policy_mismatch: '响应元数据与策略不匹配 / Response metadata mismatches policy',
      verification_error: '响应确认发生错误；聊天保持可用 / Response verification failed; chat remains available',
    };
    return messages[guard?.reason] || guard?.reason || '请求锁定准备中 / Request lock is preparing';
  }

  function ensureIndicator() {
    if (indicator?.isConnected) return indicator;
    const host = document.createElement('div');
    host.id = 'gptlock-indicator-host';
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        button{border:1px solid rgba(15,23,42,.16);border-radius:999px;padding:7px 10px;
          color:#fff;background:#64748b;font:700 12px/1.2 system-ui,sans-serif;box-shadow:0 5px 18px rgba(15,23,42,.16);cursor:pointer}
        button[data-tone="good"]{background:#15803d} button[data-tone="bad"]{background:#b91c1c}
        button[data-tone="wait"]{background:#b45309} button[data-tone="lock"]{background:#2563eb}
        button:focus{outline:3px solid #bfdbfe}
      </style>
      <button type="button" title="打开 GPTWork 设置 / Open GPTWork settings">GPTWork · 检查中</button>`;
    root.querySelector('button').addEventListener('click', () => {
      void sendMessage({ type: 'GPTLOCK_OPEN_OPTIONS' }).catch(() => {});
    });
    document.documentElement.append(host);
    indicator = host;
    return host;
  }

  function renderIndicator() {
    const host = ensureIndicator();
    const button = host.shadowRoot.querySelector('button');
    const guard = cachedState?.guard;
    const auto = cachedState?.autoVerification;
    if (auto?.running) {
      button.textContent = `GPTWork · 自动验证 ${auto.attempt || 1}/${auto.maxAttempts || 2}`;
      button.dataset.tone = 'wait';
      button.title = '自动验证正在进行；证据不足时会自动重试 / Auto verification is running and will retry incomplete evidence.';
      return;
    }
    const labels = {
      lock_ready: ['请求已锁', 'lock'],
      verified: ['已确认', 'good'],
      mismatch: [guard?.canSend ? '有告警' : '模型不符', guard?.canSend ? 'wait' : 'bad'],
      preflight_mismatch: ['页面不同', 'wait'],
      preflight_unknown: ['页面未知', 'wait'],
      waiting: ['等待确认', 'wait'],
      unverified: ['确认不足', 'wait'],
      error: ['确认错误', 'wait'],
      monitor_offline: ['锁定器离线', 'wait'],
      verification_disabled: ['仅请求锁', 'lock'],
      core_offline: ['核心离线', 'wait'],
      disabled: ['已关闭', 'off'],
    };
    const [label, tone] = labels[guard?.status] || ['检查中', 'wait'];
    button.textContent = `GPTWork · ${label}`;
    button.dataset.tone = tone;
    const autoReason = auto?.outcome === 'model_verified_reasoning_unconfirmed'
      ? '自动验证已重试：模型已确认，但 ChatGPT 未暴露推理强度元数据。'
      : auto?.outcome && auto.outcome !== 'verified'
        ? `自动验证已结束：${auto.reason || auto.outcome}；已尝试 ${auto.attempts?.length || 0} 次。`
        : null;
    button.title = `${autoReason || reasonText(guard)}\n点击打开设置 / Click to open settings`;
  }

  function showNotice(guard) {
    const existing = document.getElementById('gptlock-notice-host');
    existing?.remove();
    const host = document.createElement('div');
    host.id = 'gptlock-notice-host';
    host.style.cssText = 'all:initial;position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        div{max-width:min(560px,calc(100vw - 32px));padding:13px 16px;border:1px solid #fecaca;border-radius:13px;
          color:#7f1d1d;background:#fff7f7;box-shadow:0 12px 36px rgba(127,29,29,.2);font:600 13px/1.55 system-ui,sans-serif}
        strong{display:block;margin-bottom:2px;color:#991b1b;font-size:14px}
      </style>
      <div role="alert"><strong>GPTWork 已阻止发送 / Send blocked</strong><span></span></div>`;
    root.querySelector('span').textContent = reasonText(guard);
    document.documentElement.append(host);
    window.setTimeout(() => host.remove(), 6500);
  }

  function updateCache(payload) {
    if (payload?.state !== undefined) cachedState = payload.state;
    if (payload?.policy) cachedPolicy = payload.policy;
    if (payload?.settings) cachedSettings = payload.settings;
    renderIndicator();
    scheduleAlign();
  }

  function failOpenStaleRuntime() {
    cachedSettings = { ...(cachedSettings || {}), enabled: false };
    if (cachedState) {
      cachedState = {
        ...cachedState,
        phase: 'initial',
        guard: {
          ...(cachedState.guard || {}),
          canSend: true,
          allowKind: 'disabled',
          status: 'disabled',
          reason: 'gptlock_disabled',
        },
      };
    }
    document.getElementById('gptlock-notice-host')?.remove();
    indicator?.remove();
    indicator = null;
  }

  function locallyMarkSendStarted() {
    if (!cachedState?.guard || !cachedSettings?.networkVerificationEnabled) return;
    if (['disabled', 'outside_scope'].includes(cachedState.guard.allowKind)) return;
    cachedState = {
      ...cachedState,
      phase: 'waiting',
      guard: {
        ...cachedState.guard,
        canSend: true,
        allowKind: 'locked',
        status: 'waiting',
        reason: 'waiting_for_response_metadata',
      },
    };
    renderIndicator();
  }

  function handlePotentialSend(event) {
    if (event.type === 'submit' && Date.now() - sendConsumedAt < 750) return true;

    // The page-level listener can outlive the extension service worker when a user
    // disables/reloads/uninstalls the extension. A stale listener must never keep
    // ChatGPT blocked after GPTWork itself is no longer reachable.
    if (cachedSettings?.enabled === false || !runtimeContextAvailable()) {
      failOpenStaleRuntime();
      return true;
    }

    const guard = cachedState?.guard;
    if (!guard) return true;
    if (!guard.canSend && Date.now() - lastRuntimeContactAt > BLOCKING_GUARD_MAX_AGE_MS) {
      failOpenStaleRuntime();
      return true;
    }
    if (!guard.canSend) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      showNotice(guard);
      void sendMessage({
        type: 'GPTLOCK_SEND_BLOCKED',
        status: guard.status,
        reason: guard.reason,
      }).catch(() => failOpenStaleRuntime());
      return false;
    }
    sendConsumedAt = Date.now();
    locallyMarkSendStarted();
    void sendMessage({ type: 'GPTLOCK_SEND_STARTED' }).catch(() => failOpenStaleRuntime());
    return true;
  }

  function matchesAny(element, selectors) {
    return selectors.some((selector) => element?.closest?.(selector));
  }

  document.addEventListener('click', (event) => {
    if (matchesAny(event.target, SEND_SELECTORS)) handlePotentialSend(event);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (
      event.key === 'Enter'
      && !event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.isComposing
      && matchesAny(event.target, COMPOSER_SELECTORS)
    ) {
      handlePotentialSend(event);
    }
  }, true);

  document.addEventListener('submit', (event) => {
    if (event.target?.querySelector?.(COMPOSER_SELECTORS.join(','))) handlePotentialSend(event);
  }, true);

  async function report() {
    const observation = collectObservation();
    const fingerprint = JSON.stringify([
      observation.model,
      observation.reasoning,
      observation.modelEvidenceSource,
      observation.reasoningEvidenceSource,
      observation.modelLabel,
      observation.reasoningLabel,
      observation.ambiguousModel,
      observation.candidates,
    ]);
    if (fingerprint === previousFingerprint) return;
    previousFingerprint = fingerprint;
    try {
      const state = await sendMessage({ type: 'GPTLOCK_PAGE_OBSERVATION', observation });
      updateCache({ state });
    } catch {
      // The service worker or native host may be unavailable during browser startup.
    }
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  }

  function composerIntelligenceTrigger() {
    const direct = MODEL_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find((element) => element && visible(element));
    if (direct) return direct;

    const evidenceControls = globalThis.__GPTLOCK_PAGE_MODEL_EVIDENCE__?.modelReasoningControls?.() || [];
    const evidenceTrigger = evidenceControls
      .map((item) => item?.element)
      .find((element) => element && visible(element) && element.getAttribute?.('aria-haspopup') === 'menu');
    if (evidenceTrigger) return evidenceTrigger;

    const composer = findComposer();
    const composerRoot = composer?.closest?.('form') || composer?.parentElement || null;
    const candidates = [...new Set([
      ...composerNearbyControls(),
      ...(composerRoot ? [...composerRoot.querySelectorAll('button,[role="button"],[aria-haspopup="menu"]')] : []),
    ])].filter((element) => element && visible(element));

    const scored = candidates.map((element) => {
      const signal = [
        element.getAttribute?.('data-testid'),
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.getAttribute?.('aria-controls'),
        element.className,
        element.textContent,
      ].map((value) => String(value || '')).join(' ');
      let score = 0;
      if (/composer-intelligence-picker-content|intelligence|model-switcher/i.test(signal)) score += 100;
      if (/__composer-pill/.test(signal)) score += 80;
      if (element.getAttribute?.('aria-haspopup') === 'menu') score += 40;
      if (/gpt|model|reasoning|thinking|推理|模型|思考|high|medium|low|高|中|低/i.test(signal)) score += 25;
      if (composerRoot?.contains?.(element)) score += 20;
      return { element, score };
    }).filter((item) => item.score >= 60).sort((a, b) => b.score - a.score);
    return scored[0]?.element || null;
  }

  function modelTrigger(triggerSelectors = MODEL_SELECTORS) {
    if (triggerSelectors !== MODEL_SELECTORS) {
      return triggerSelectors
        .map((selector) => document.querySelector(selector))
        .find((element) => element && visible(element)) || null;
    }
    return composerIntelligenceTrigger();
  }

  function menuCandidates() {
    const selectors = [
      '[role="menu"] [role="menuitem"]',
      '[role="menu"] [role="menuitemradio"]',
      '[role="menu"] [role="radio"]',
      '[role="menu"] button',
      '[role="listbox"] [role="option"]',
      '[role="listbox"] [role="radio"]',
      '[role="listbox"] button',
      '[data-radix-menu-content] [role="menuitem"]',
      '[data-radix-menu-content] [role="menuitemradio"]',
      '[data-radix-menu-content] [role="radio"]',
      '[data-radix-menu-content] button',
      '[data-testid="modal-intelligence-menu"] [role="radio"]',
      '[data-testid="composer-intelligence-picker-content"] [role="menuitemradio"]',
      '[data-model]',
      '[data-model-id]',
    ];
    return [...new Set([...document.querySelectorAll(selectors.join(','))])].filter(visible);
  }

  function elementCenter(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.left + Math.max(1, rect.width / 2),
      y: rect.top + Math.max(1, rect.height / 2),
    };
  }

  function dispatchSyntheticPointer(element, action = 'click') {
    const point = elementCenter(element);
    if (!point) return false;
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
    };
    const PointerCtor = window.PointerEvent || window.MouseEvent;
    if (action === 'move') {
      for (const type of ['pointerover', 'pointerenter', 'pointermove']) {
        try { element.dispatchEvent(new PointerCtor(type, { ...common, pointerType: 'mouse', isPrimary: true })); } catch {}
      }
      for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
        try { element.dispatchEvent(new MouseEvent(type, common)); } catch {}
      }
      return true;
    }
    try { element.dispatchEvent(new PointerCtor('pointerover', { ...common, pointerType: 'mouse', isPrimary: true, buttons: 0 })); } catch {}
    try { element.dispatchEvent(new PointerCtor('pointerdown', { ...common, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 })); } catch {}
    try { element.dispatchEvent(new MouseEvent('mousedown', { ...common, button: 0, buttons: 1 })); } catch {}
    try { element.dispatchEvent(new PointerCtor('pointerup', { ...common, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 })); } catch {}
    try { element.dispatchEvent(new MouseEvent('mouseup', { ...common, button: 0, buttons: 0 })); } catch {}
    try { element.dispatchEvent(new MouseEvent('click', { ...common, button: 0, buttons: 0, detail: 1 })); } catch {}
    return true;
  }

  async function trustedPointer(element, action = 'click') {
    if (!element || !visible(element)) return false;
    try { element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch {}
    try { element.focus?.({ preventScroll: true }); } catch {}
    const point = elementCenter(element);
    if (!point) return false;
    try {
      await sendMessage({ type: 'GPTLOCK_TRUSTED_POINTER', action, x: point.x, y: point.y });
      return true;
    } catch {
      return dispatchSyntheticPointer(element, action);
    }
  }

  function visibleIntelligencePickerContent() {
    return [...document.querySelectorAll('[data-testid="composer-intelligence-picker-content"]')]
      .find((element) => visible(element)) || null;
  }

  function modelSubmenuOpener(picker) {
    const rows = [...(picker?.querySelectorAll?.('[role="menuitem"]') || [])].filter(visible);
    return [...rows].reverse().find((element) =>
      element.hasAttribute?.('data-has-submenu')
      || element.getAttribute?.('aria-haspopup') === 'menu'
      || Boolean(element.getAttribute?.('aria-controls')),
    ) || null;
  }

  function visibleModelSubmenu(picker, opener) {
    const controlledId = opener?.getAttribute?.('aria-controls') || '';
    const controlled = controlledId ? document.getElementById(controlledId) : null;
    if (controlled && visible(controlled) && controlled.querySelector?.('[role="menuitemradio"]')) return controlled;
    const pickerMenu = picker?.closest?.('[role="menu"]') || null;
    const openerId = opener?.id || '';
    const menus = [...document.querySelectorAll('[role="menu"]')].filter((menu) =>
      visible(menu)
      && menu !== pickerMenu
      && !picker?.contains?.(menu)
      && Boolean(menu.querySelector?.('[role="menuitemradio"]')),
    );
    if (openerId) {
      const labelled = menus.find((menu) => menu.getAttribute?.('aria-labelledby') === openerId);
      if (labelled) return labelled;
    }
    return menus.find((menu) => /gpt|astra|sol|model|模型/i.test(menu.innerText || menu.textContent || ''))
      || menus[0]
      || null;
  }

  async function openModernModelMenu() {
    const trigger = composerIntelligenceTrigger();
    if (!trigger) return { trigger: null, picker: null, opener: null, submenu: null, rows: [] };

    let picker = visibleIntelligencePickerContent();
    if (!picker) {
      await trustedPointer(trigger, 'click');
      picker = await waitUntil(visibleIntelligencePickerContent, 2200, 80);
    }
    if (!picker) {
      try {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        trigger.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      } catch {}
      picker = await waitUntil(visibleIntelligencePickerContent, 1200, 80);
    }
    if (!picker) return { trigger, picker: null, opener: null, submenu: null, rows: [] };

    const opener = modelSubmenuOpener(picker);
    if (!opener) return { trigger, picker, opener: null, submenu: null, rows: [] };

    let submenu = visibleModelSubmenu(picker, opener);
    if (!submenu) {
      await trustedPointer(opener, 'move');
      dispatchSyntheticPointer(opener, 'move');
      submenu = await waitUntil(() => visibleModelSubmenu(picker, opener), 1800, 90);
    }
    if (!submenu) {
      try { opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })); } catch {}
      submenu = await waitUntil(() => visibleModelSubmenu(picker, opener), 900, 90);
    }
    const rows = submenu
      ? [...submenu.querySelectorAll('[role="menuitemradio"],[role="radio"],button')].filter(visible)
      : [];
    return { trigger, picker, opener, submenu, rows };
  }

  function rowModelDescriptor(row) {
    const evidence = globalThis.__GPTLOCK_PAGE_MODEL_EVIDENCE__;
    const testId = String(row?.getAttribute?.('data-testid') || '').trim();
    const testIdModel = testId.match(/^model-switcher-(gpt-[a-z0-9._:-]+)$/i)?.[1] || null;
    const attributes = [
      row?.getAttribute?.('data-model'),
      row?.getAttribute?.('data-model-id'),
      row?.getAttribute?.('data-value'),
      testIdModel,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const values = [
      ...attributes,
      row?.getAttribute?.('aria-label'),
      row?.getAttribute?.('title'),
      row?.innerText,
      row?.textContent,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const rawId = attributes.find((value) => /^[a-z0-9._:-]{2,128}$/i.test(value) && /gpt/i.test(value))
      || values.find((value) => /^[a-z0-9._:-]{2,128}$/i.test(value) && /gpt/i.test(value))
      || null;
    const model = values.map((value) => normalizeDisplayedModel(value)).find(Boolean)
      || values.map((value) => evidence?.modelFromText?.(value)).find(Boolean)
      || rawId;
    const label = values.find((value) => /gpt|astra|sol|thinking|latest|最新|pro|terra|luna/i.test(value))
      || model
      || rawId
      || '';
    return { rawId, model, label, values };
  }

  async function closeModelMenus(trigger = null) {
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); } catch {}
    await new Promise((resolve) => window.setTimeout(resolve, 90));
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); } catch {}
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    if (visibleIntelligencePickerContent() && trigger) await trustedPointer(trigger, 'click');
  }

  async function chooseModelExact(desired) {
    const modern = await openModernModelMenu();
    if (modern.rows.length) {
      const candidate = modern.rows.find((row) => {
        const descriptor = rowModelDescriptor(row);
        return descriptor.model === desired || descriptor.rawId === desired;
      });
      if (candidate) {
        await trustedPointer(candidate, 'click');
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        const confirmed = await waitUntil(() => collectObservation().model === desired, 3000, 100);
        if (confirmed) return true;
      }
      await closeModelMenus(modern.trigger);
    }
    return chooseExact(MODEL_SELECTORS, desired, normalizeDisplayedModel, { skipModern: true });
  }

  async function chooseExact(triggerSelectors, desired, normalize, { skipModern = false } = {}) {
    if (!skipModern && triggerSelectors === MODEL_SELECTORS) return chooseModelExact(desired);
    const trigger = modelTrigger(triggerSelectors);
    if (!trigger) return false;
    const current = elementTexts(trigger).map(normalize).find(Boolean);
    if (current === desired) return true;
    await trustedPointer(trigger, 'click');
    const candidates = await waitUntil(() => {
      const rows = menuCandidates();
      return rows.length ? rows : null;
    }, 2500, 80);
    const candidate = (candidates || []).find((element) => {
      const values = [
        element.getAttribute?.('data-model'),
        element.getAttribute?.('data-model-id'),
        element.getAttribute?.('data-value'),
        element.getAttribute?.('data-testid'),
        ...elementTexts(element),
      ].filter(Boolean);
      return values.some((text) => normalize(text) === desired);
    });
    if (!candidate) {
      await trustedPointer(trigger, 'click');
      return false;
    }
    await trustedPointer(candidate, 'click');
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    return true;
  }

  async function alignSelection({ force = false } = {}) {
    if (!cachedSettings?.enabled || !cachedSettings.autoAlignSelection || !cachedPolicy || document.querySelector(GENERATING_SELECTORS.join(','))) return false;
    const observation = collectObservation();
    const desiredModel = cachedPolicy.lockedModels?.[0];
    const preferred = cachedPolicy.allowedReasoningLevels?.includes(cachedSettings.preferredReasoning)
      ? cachedSettings.preferredReasoning
      : cachedPolicy.allowedReasoningLevels?.[0];
    const signature = JSON.stringify([location.pathname, desiredModel, preferred, observation.model, observation.reasoning, force]);
    if (!force && signature === lastAlignAttempt && Date.now() - lastAlignAt < 30000) return false;
    lastAlignAttempt = signature;
    lastAlignAt = Date.now();

    let changed = false;
    if (desiredModel && observation.model && observation.model !== desiredModel) {
      changed = await chooseExact(MODEL_SELECTORS, desiredModel, normalizeDisplayedModel);
    }
    const afterModel = changed ? collectObservation() : observation;
    if (preferred && !changed && afterModel.reasoning && afterModel.reasoning !== preferred) {
      changed = await chooseExact(REASONING_SELECTORS, preferred, normalizeDisplayedReasoning);
    }
    if (changed) window.setTimeout(() => void report(), 700);
    return changed;
  }

  function scheduleAlign() {
    clearTimeout(alignTimer);
    alignTimer = window.setTimeout(() => void alignSelection(), 900);
  }

  function scheduleReport() {
    clearTimeout(reportTimer);
    reportTimer = window.setTimeout(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        previousFingerprint = '';
        void sendMessage({ type: 'GPTLOCK_CONTEXT_CHANGED', url: lastUrl })
          .then((state) => updateCache({ state }))
          .catch(() => {});
      }
      void report();
      scheduleAlign();
    }, 900);
  }

  function findComposer() {
    return COMPOSER_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find((element) => element && visible(element)) || null;
  }

  function composerText(composer) {
    if (!composer) return '';
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) return composer.value || '';
    return composer.innerText || composer.textContent || '';
  }

  function dispatchComposerInput(composer, text) {
    try {
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      }));
    } catch {
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setComposerText(composer, text) {
    if (composer instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      descriptor?.set?.call(composer, text);
      dispatchComposerInput(composer, text);
      return;
    }
    if (composer instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      descriptor?.set?.call(composer, text);
      dispatchComposerInput(composer, text);
      return;
    }

    composer.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      composer.textContent = text;
      dispatchComposerInput(composer, text);
    }
  }

  function findSendButton() {
    return SEND_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find((element) => element && visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true') || null;
  }

  async function waitUntil(predicate, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
    }
    return null;
  }

  async function waitForIdle() {
    const idle = await waitUntil(
      () => !document.querySelector(GENERATING_SELECTORS.join(',')),
      30000,
      250,
    );
    if (!idle) throw new Error('ChatGPT is still generating / ChatGPT 仍在生成回复');
  }

  async function autoSendProbe(options = {}) {
    if (autoProbeRunning) throw new Error('Automatic verification is already running / 自动验证正在进行');
    autoProbeRunning = true;
    try {
      await waitForIdle();
      if (options.skipAlignment !== true) {
        await alignSelection({ force: true });
        await new Promise((resolve) => window.setTimeout(resolve, 450));
      }

      const composer = await waitUntil(findComposer, 5000, 100);
      if (!composer) throw new Error('ChatGPT composer not found / 未找到 ChatGPT 输入框');
      const originalDraft = composerText(composer);
      const draftPreserved = Boolean(originalDraft.trim());
      const probeText = typeof options.probeText === 'string' && options.probeText.trim()
        ? options.probeText.trim().slice(0, 500)
        : AUTO_PROBE_TEXT;
      const probeMarker = typeof options.probeMarker === 'string' && options.probeMarker.trim()
        ? options.probeMarker.trim().slice(0, 120)
        : 'GPTWork 自动验证';

      setComposerText(composer, probeText);
      const filled = await waitUntil(() => composerText(composer).includes(probeMarker), 2500, 80);
      if (!filled) throw new Error('Failed to write visible test message / 无法写入可见测试消息');

      const sendButton = await waitUntil(findSendButton, 5000, 100);
      if (!sendButton) {
        if (draftPreserved) setComposerText(composer, originalDraft);
        throw new Error('ChatGPT send button is unavailable / ChatGPT 发送按钮不可用');
      }
      sendButton.click();

      const sent = await waitUntil(() => {
        const currentComposer = findComposer();
        const current = composerText(currentComposer);
        return !current.includes(probeMarker) || Boolean(document.querySelector(GENERATING_SELECTORS.join(',')));
      }, 5000, 100);
      if (!sent) {
        if (draftPreserved) setComposerText(composer, originalDraft);
        throw new Error('Visible test message was not accepted by ChatGPT / 可见测试消息未被 ChatGPT 接收');
      }

      let draftRestored = false;
      if (draftPreserved) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        const restoreComposer = await waitUntil(findComposer, 3000, 100);
        if (restoreComposer) {
          setComposerText(restoreComposer, originalDraft);
          draftRestored = composerText(restoreComposer).trim() === originalDraft.trim();
        }
      }
      return {
        sent: true,
        method: 'visible_composer_click',
        draftPreserved,
        draftRestored,
      };
    } finally {
      autoProbeRunning = false;
    }
  }

  function assistantMessages() {
    return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  }

  async function resolveModelNamesWithChatGpt(message) {
    const before = assistantMessages().length;
    const result = await autoSendProbe({
      probeText: String(message?.prompt || '').slice(0, 1800),
      probeMarker: 'GPTWork 模型名称解析',
    });
    const response = await waitUntil(() => {
      const messages = assistantMessages();
      if (messages.length <= before) return null;
      const text = String(messages[messages.length - 1]?.innerText || messages[messages.length - 1]?.textContent || '').trim();
      return text || null;
    }, 45000, 250);
    return { ...result, responseText: response || '' };
  }

  async function verifyAccountModel(message) {
    const model = normalizeDisplayedModel(message?.model) || String(message?.model || '').trim().toLowerCase();
    if (!model) throw new Error('Invalid account model / 无效账户模型');
    await waitForIdle();
    const selected = await chooseModelExact(model);
    const confirmedObservation = selected
      ? await waitUntil(() => {
        const observation = collectObservation();
        return observation.model === model ? observation : null;
      }, 3000, 100)
      : null;
    const observation = confirmedObservation || collectObservation();
    const confirmed = observation.model === model;
    return {
      model,
      label: message?.label || model,
      selected: selected || confirmed,
      confirmed,
      observation,
      capturedAt: new Date().toISOString(),
    };
  }

  async function discoverAccountModelMetadata() {
    const evidence = globalThis.__GPTLOCK_PAGE_MODEL_EVIDENCE__;
    const currentBeforeOpen = collectObservation();
    const models = [];
    const reasoning = new Set();
    let candidateCount = 0;
    let triggerFound = false;

    const rememberRow = (row) => {
      const descriptor = rowModelDescriptor(row);
      const canonical = descriptor.model;
      if (!canonical) return;
      if (!models.some((item) => item.rawId === descriptor.rawId && item.model === canonical)) {
        models.push({ rawId: descriptor.rawId, model: canonical, label: descriptor.label || canonical });
      }
    };

    const modern = await openModernModelMenu();
    triggerFound = Boolean(modern.trigger);
    if (modern.picker) {
      for (const row of [...modern.picker.querySelectorAll('[role="menuitemradio"],[role="radio"]')].filter(visible)) {
        for (const value of elementTexts(row)) {
          const level = normalizeDisplayedReasoning(value) || evidence?.reasoningFromText?.(value);
          if (level) reasoning.add(level);
        }
      }
    }
    if (modern.rows.length) {
      candidateCount = modern.rows.length;
      for (const row of modern.rows) rememberRow(row);
      await closeModelMenus(modern.trigger);
    } else {
      await closeModelMenus(modern.trigger);
      const trigger = modelTrigger(MODEL_SELECTORS);
      triggerFound = triggerFound || Boolean(trigger);
      const wasExpanded = trigger?.getAttribute?.('aria-expanded') === 'true';
      let openedByUs = false;
      if (trigger && !wasExpanded) {
        await trustedPointer(trigger, 'click');
        openedByUs = true;
      }
      const rows = trigger
        ? (await waitUntil(() => {
          const candidates = menuCandidates();
          return candidates.length ? candidates : null;
        }, 2200, 80)) || []
        : [];
      candidateCount = rows.length;
      for (const row of rows) {
        rememberRow(row);
        for (const value of elementTexts(row)) {
          const level = normalizeDisplayedReasoning(value) || evidence?.reasoningFromText?.(value);
          if (level) reasoning.add(level);
        }
      }
      if (openedByUs && trigger) await trustedPointer(trigger, 'click');
    }

    const current = currentBeforeOpen?.model ? currentBeforeOpen : collectObservation();
    if (current?.model && !models.some((item) => item.model === current.model)) {
      models.push({ rawId: current.model, model: current.model, label: current.modelLabel || current.model });
    }
    if (current?.reasoning) reasoning.add(current.reasoning);
    return {
      models,
      reasoningLevels: [...reasoning],
      capturedAt: new Date().toISOString(),
      candidateCount,
      triggerFound,
      pickerKind: modern.picker ? 'unified-intelligence' : 'legacy',
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GPTLOCK_AUTO_RESOLVE_MODEL_NAMES') {
      void resolveModelNamesWithChatGpt(message).then(
        (result) => sendResponse({ ok: true, ...result }),
        (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (message?.type === 'GPTLOCK_VERIFY_ACCOUNT_MODEL') {
      void verifyAccountModel(message).then(
        (result) => sendResponse({ ok: true, result }),
        (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (message?.type === 'GPTLOCK_DISCOVER_ACCOUNT_MODELS') {
      void discoverAccountModelMetadata().then(
        (catalog) => sendResponse({ ok: true, catalog }),
        (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (message?.type === 'GPTLOCK_COLLECT_PAGE_STATE') {
      sendResponse({ ok: true, observation: collectObservation() });
      return false;
    }
    if (message?.type === 'GPTLOCK_GUARD_STATE') {
      lastRuntimeContactAt = Date.now();
      updateCache(message);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'GPTLOCK_AUTO_SEND_PROBE') {
      void autoSendProbe(message).then(
        (result) => sendResponse({ ok: true, ...result }),
        (error) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return true;
    }
    return false;
  });

  new MutationObserver(scheduleReport).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'aria-label',
      'aria-checked',
      'aria-selected',
      'data-state',
      'data-selected',
      'data-value',
      'data-model',
      'data-model-id',
      'title',
      'data-testid',
    ],
  });

  window.setInterval(() => {
    if (cachedSettings?.enabled === false || cachedState?.guard?.canSend !== false) return;
    if (!runtimeContextAvailable()) {
      failOpenStaleRuntime();
      return;
    }
    void sendMessage({ type: 'GPTLOCK_GET_STATE' })
      .then((state) => updateCache({ state: state.tabState, policy: state.policy, settings: state.settings }))
      .catch(() => failOpenStaleRuntime());
  }, BLOCKING_GUARD_HEARTBEAT_MS);

  ensureIndicator();
  void sendMessage({ type: 'GPTLOCK_GET_STATE' })
    .then((state) => updateCache({ state: state.tabState, policy: state.policy, settings: state.settings }))
    .catch(() => failOpenStaleRuntime());
  scheduleReport();
})();
