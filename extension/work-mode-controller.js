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
  const REFRESH_DELAY_MS = 800;

  // Fail inert. Work selection is now owned by this ChatGPT tab, while the background
  // account/master gate remains a separate prerequisite.
  let workModeSelected = false;
  let backgroundAllowed = false;
  let enabled = false;
  let refreshTimer = null;
  let noticeTimer = null;
  let switchingBack = false;
  let verificationOwned = false;

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

  function workEvidenceSnapshot() {
    // Avoid innerText/getBoundingClientRect over the entire ChatGPT document. In
    // v0.5.112 this scan ran after broad DOM mutations and repeatedly consumed
    // 50-190ms on the renderer main thread. Scan cheap textContent once, then run
    // visibility/layout checks only for the handful of exact evidence candidates.
    let conversationMarker = false;
    let hasOutput = false;
    let hasSources = false;
    let hasCreate = false;
    let sourceCount = 0;
    let sourceToggle = false;
    const sourceHits = new Set();
    const candidates = document.querySelectorAll('h1,h2,button,span,[data-tpp-source-group-toggle]');
    // Keep the evidence boundary explicit: Work evidence must live outside a
    // conversation turn, never inside assistant/user transcript content.
    const outsideConversationEvidence = outsideConversation;

    for (const element of candidates) {
      if (!outsideConversationEvidence(element)) continue;
      const text = normalize(element.textContent);
      let matched = false;

      if (!conversationMarker && WORK_TITLE_SUFFIX.test(text)) {
        conversationMarker = true;
        matched = true;
      }
      if (/^(?:输出内容|output content|outputs?)$/i.test(text)) {
        hasOutput = true;
        matched = true;
      }
      if (/^(?:来源|sources?)$/i.test(text)) {
        hasSources = true;
        matched = true;
      }
      if (/^(?:创建文件或网站|create (?:a )?(?:file|website)(?: or (?:a )?(?:file|website))?)$/i.test(text)) {
        hasCreate = true;
        matched = true;
      }
      for (const [key, pattern] of [
        ['web', /^(?:网页搜索|web search)$/i],
        ['file', /^(?:文件搜索|file search)$/i],
        ['memory', /^(?:记忆|memory)$/i],
      ]) {
        if (!sourceHits.has(key) && pattern.test(text)) {
          sourceHits.add(key);
          matched = true;
        }
      }
      if (element.hasAttribute?.('data-tpp-source-group-toggle')) {
        sourceToggle = true;
        matched = true;
      }

      // Exact text can also exist in hidden menus. Only matched candidates pay the
      // layout cost; never force layout for every span/div in the transcript.
      if (matched && !visible(element)) {
        if (WORK_TITLE_SUFFIX.test(text)) conversationMarker = false;
        if (/^(?:输出内容|output content|outputs?)$/i.test(text)) hasOutput = false;
        if (/^(?:来源|sources?)$/i.test(text)) hasSources = false;
        if (/^(?:创建文件或网站|create (?:a )?(?:file|website)(?: or (?:a )?(?:file|website))?)$/i.test(text)) hasCreate = false;
        if (element.hasAttribute?.('data-tpp-source-group-toggle')) sourceToggle = false;
        for (const [key, pattern] of [
          ['web', /^(?:网页搜索|web search)$/i],
          ['file', /^(?:文件搜索|file search)$/i],
          ['memory', /^(?:记忆|memory)$/i],
        ]) {
          if (pattern.test(text)) sourceHits.delete(key);
        }
      }
    }

    sourceCount = sourceHits.size;
    return {
      conversationMarker,
      panel: {
        confirmed: hasOutput && hasSources && (hasCreate || sourceCount > 0 || sourceToggle),
        hasOutput,
        hasSources,
        hasCreate,
        sourceCount,
        sourceToggle,
      },
    };
  }

  function detectProcessingMode() {
    const evidence = workEvidenceSnapshot();
    const { conversationMarker, panel } = evidence;
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
    if (!enabled || document.hidden) {
      row.dataset.status = 'chat';
      const value = row.querySelector('.model-value');
      if (value && value.textContent !== '聊天模式') value.textContent = '聊天模式';
      row.title = enabled ? '页面位于后台，暂停工作模式 DOM 扫描。' : 'GPTWork 工作模式未启用。';
      return;
    }
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
    // Verification owns Chat/Work mode while probing account capabilities. The user's
    // Work toggle must not switch the page back to Chat during that transaction.
    if (verificationOwned || !enabled || !isPristineNewChat()) return;
    const control = event.target?.closest?.(MODE_CONTROL_SELECTOR);
    if (!isWorkControl(control)) return;
    showGuidance();
    switchBackToChat();
  }, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'GPTLOCK_GUARD_STATE') {
      backgroundAllowed = message.settings?.enabled === true;
      verificationOwned = message.state?.autoVerification?.running === true;
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

  new MutationObserver((mutations) => {
    if (!enabled || document.hidden) return;
    // Do not refresh Work evidence for generic class/state churn. ChatGPT mutates
    // those attributes continuously during streaming, scrolling and window resize.
    // Refresh only when newly-added structural content can actually contain Work UI.
    const relevant = mutations.some((mutation) => {
      if (mutation.type !== 'childList' || !mutation.addedNodes?.length) return false;
      return [...mutation.addedNodes].some((node) => {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        if (!element || element.closest?.(TURN_SELECTOR)) return false;
        const text = normalize(element.textContent).slice(0, 1200);
        return /(?:输出内容|output content|来源|sources?|创建文件或网站|create (?:a )?(?:file|website)|[·•]\s*(?:工作|work))/i.test(text)
          || Boolean(element.querySelector?.('[data-tpp-source-group-toggle]'));
      });
    });
    if (relevant) scheduleRefresh();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
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
