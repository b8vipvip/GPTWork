(() => {
  const NOTICE_ID = 'gptwork-work-mode-guidance-host';
  const MODEL_INDICATOR_ID = 'gptlock-model-indicator-host';
  const WORK_LABEL = /^(?:工作|work)$/i;
  const CHAT_LABEL = /^(?:聊天|chat)$/i;
  const WORK_TITLE_SUFFIX = /[·•]\s*(?:工作|work)\s*$/i;
  const GENERATING_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="停止"]',
  ];
  const TURN_SELECTOR = '[data-message-author-role],article[data-testid^="conversation-turn-"]';
  const MODE_CONTROL_SELECTOR = 'button,[role="tab"],[role="button"]';
  const GUIDANCE_TEXT = '无需手动选择工作模式，在聊天模式直接发消息或任务后GPT自动以工作模式处理问题';
  const REFRESH_DELAY_MS = 120;

  // Fail inert. Work selection is now owned by this ChatGPT tab, while the background
  // account/master gate remains a separate prerequisite.
  let workModeSelected = false;
  let backgroundAllowed = false;
  let enabled = false;
  let refreshTimer = null;
  let noticeTimer = null;
  let switchingBack = false;

  function syncEnabled() {
    enabled = Boolean(workModeSelected && backgroundAllowed);
  }

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function visible(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function outsideConversation(element) {
    if (!element || element.closest?.(TURN_SELECTOR)) return false;
    if (element.closest?.(`#${NOTICE_ID},#${MODEL_INDICATOR_ID},#gptlock-indicator-host`)) return false;
    return true;
  }

  function isConversationRoute() {
    return /(?:^|\/)c\/[a-zA-Z0-9_-]+(?:\/|$)/.test(location.pathname);
  }

  function isPristineNewChat() {
    if (isConversationRoute()) return false;
    return !document.querySelector(TURN_SELECTOR);
  }

  function topModeControl(kind) {
    const pattern = kind === 'work' ? WORK_LABEL : CHAT_LABEL;
    return [...document.querySelectorAll(MODE_CONTROL_SELECTOR)].find((element) => {
      if (!visible(element) || !pattern.test(normalize(element.innerText || element.textContent))) return false;
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.top < 110 && rect.width > 24 && rect.width < 220;
    }) || null;
  }

  function isWorkControl(element) {
    if (!element || !visible(element)) return false;
    if (!WORK_LABEL.test(normalize(element.innerText || element.textContent))) return false;
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.top < 110 && rect.width > 24 && rect.width < 220;
  }

  function showGuidance() {
    document.getElementById(NOTICE_ID)?.remove();
    clearTimeout(noticeTimer);

    const host = document.createElement('div');
    host.id = NOTICE_ID;
    host.style.cssText = 'all:initial;position:fixed;left:50%;top:76px;transform:translateX(-50%);z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        div{max-width:min(680px,calc(100vw - 32px));padding:12px 16px;border:1px solid rgba(37,99,235,.24);border-radius:12px;
          color:#1e3a8a;background:rgba(239,246,255,.98);box-shadow:0 12px 34px rgba(15,23,42,.16);font:650 13px/1.55 system-ui,sans-serif}
      </style>
      <div role="status" aria-live="polite"></div>`;
    root.querySelector('div').textContent = GUIDANCE_TEXT;
    document.documentElement.append(host);
    noticeTimer = window.setTimeout(() => host.remove(), 5200);
  }

  function switchBackToChat() {
    if (switchingBack) return;
    switchingBack = true;
    const attempt = (remaining) => {
      const chat = topModeControl('chat');
      if (chat) chat.click();
      if (remaining > 0) {
        window.setTimeout(() => attempt(remaining - 1), 140);
      } else {
        switchingBack = false;
      }
    };
    window.setTimeout(() => attempt(3), 40);
  }

  function workConversationMarker() {
    for (const element of document.querySelectorAll('span,div')) {
      if (!visible(element) || !outsideConversation(element)) continue;
      const text = normalize(element.innerText || element.textContent);
      if (!WORK_TITLE_SUFFIX.test(text)) continue;
      const spans = element.querySelectorAll?.('span')?.length || 0;
      if (spans >= 2 || (element.parentElement && WORK_TITLE_SUFFIX.test(normalize(element.parentElement.innerText)))) {
        return true;
      }
    }
    return false;
  }

  function exactVisibleText(pattern, selector = 'span,div,button,h2') {
    return [...document.querySelectorAll(selector)].some((element) => {
      if (!visible(element) || !outsideConversation(element)) return false;
      return pattern.test(normalize(element.innerText || element.textContent));
    });
  }

  function workPanelEvidence() {
    const hasOutput = exactVisibleText(/^(?:输出内容|output content|outputs?)$/i, 'h2,h2 span,span,div');
    const hasSources = exactVisibleText(/^(?:来源|sources?)$/i, 'h2,h2 span,button,span,div');
    const hasCreate = exactVisibleText(/^(?:创建文件或网站|create (?:a )?(?:file|website)(?: or (?:a )?(?:file|website))?)$/i, 'button,span,div');
    const sourcePatterns = [
      /^(?:网页搜索|web search)$/i,
      /^(?:文件搜索|file search)$/i,
      /^(?:记忆|memory)$/i,
    ];
    const sourceCount = sourcePatterns.filter((pattern) => exactVisibleText(pattern, 'button,span,div')).length;
    const sourceToggle = [...document.querySelectorAll('[data-tpp-source-group-toggle]')]
      .some((element) => visible(element) && outsideConversation(element));
    return {
      confirmed: hasOutput && hasSources && (hasCreate || sourceCount > 0 || sourceToggle),
      hasOutput,
      hasSources,
      hasCreate,
      sourceCount,
      sourceToggle,
    };
  }

  function detectProcessingMode() {
    const conversationMarker = workConversationMarker();
    const panel = workPanelEvidence();
    const confirmed = conversationMarker && panel.confirmed;
    return {
      mode: confirmed ? 'work' : 'chat',
      confirmed,
      conversationMarker,
      panel,
      generating: Boolean(document.querySelector(GENERATING_SELECTORS.join(','))),
    };
  }

  function ensureProcessingModeRow() {
    const host = document.getElementById(MODEL_INDICATOR_ID);
    const root = host?.shadowRoot;
    const button = root?.querySelector('button');
    if (!root || !button) return null;

    let row = root.querySelector('[data-source="processing-mode"]');
    if (!row) {
      row = document.createElement('span');
      row.className = 'model-row';
      row.dataset.source = 'processing-mode';
      row.dataset.status = 'chat';
      row.style.gridTemplateColumns = '84px minmax(0,1fr)';
      row.innerHTML = '<span class="model-key">消息处理模式</span><span class="model-value">聊天模式</span>';
      const pageRow = root.querySelector('[data-source="page"]');
      if (pageRow) button.insertBefore(row, pageRow);
      else button.prepend(row);
    }
    return row;
  }

  function renderProcessingMode() {
    refreshTimer = null;
    const row = ensureProcessingModeRow();
    if (!row) return;
    const evidence = detectProcessingMode();
    row.dataset.status = evidence.confirmed ? 'confirmed' : 'chat';
    const value = row.querySelector('.model-value');
    const label = evidence.confirmed ? '工作模式' : '聊天模式';
    if (value && value.textContent !== label) value.textContent = label;
    const detail = evidence.confirmed
      ? '已确认工作模式：会话标题带“· 工作”，且页面出现工作输出/来源面板。'
      : '当前未取得完整工作模式页面证据，按聊天模式显示。';
    row.title = detail;
    row.setAttribute('aria-label', `消息处理模式：${label}。${detail}`);
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = window.setTimeout(renderProcessingMode, REFRESH_DELAY_MS);
  }

  document.addEventListener('click', (event) => {
    if (!enabled || !isPristineNewChat()) return;
    const control = event.target?.closest?.(MODE_CONTROL_SELECTOR);
    if (!isWorkControl(control)) return;
    showGuidance();
    switchBackToChat();
  }, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'GPTLOCK_GUARD_STATE') {
      backgroundAllowed = message.settings?.enabled === true;
      syncEnabled();
      scheduleRefresh();
    }
    if (message?.type === 'GPTWORK_TAB_FEATURE_STATE') {
      workModeSelected = message.featureState?.workModeEnabled === true;
      syncEnabled();
      scheduleRefresh();
    }
    return false;
  });

  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'aria-pressed', 'data-state', 'data-testid', 'class'],
  });

  window.addEventListener('popstate', scheduleRefresh);
  window.addEventListener('hashchange', scheduleRefresh);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRefresh();
  });

  chrome.runtime.sendMessage({ type: 'GPTWORK_TAB_FEATURE_GET' }, (featureResponse) => {
    if (!chrome.runtime.lastError && featureResponse?.ok) {
      workModeSelected = featureResponse.data?.featureState?.workModeEnabled === true;
    }
    chrome.runtime.sendMessage({ type: 'GPTLOCK_GET_STATE' }, (response) => {
      if (!chrome.runtime.lastError && response?.ok) {
        const account = response.data?.account;
        backgroundAllowed = response.data?.settings?.enabled === true
          && response.data?.accountWindowAllowed !== false
          && account?.authenticated === true
          && account?.entitlement?.active === true;
      }
      syncEnabled();
      scheduleRefresh();
    });
  });
  scheduleRefresh();
})();
