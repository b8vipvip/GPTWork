(() => {
  const KEY = '__GPTLOCK_CHAT_LENGTH_REMAINING_TRUTH__';
  if (globalThis[KEY]) return;

  const OWN_NOTICE_SELECTOR = '#gptlock-context-warning-host,#gptlock-context-learning-toast,#gptlock-context-hard-limit-toast';
  const CONVERSATION_TURN_SELECTOR = '[data-message-author-role],article[data-testid^="conversation-turn-"]';
  const HARD_LIMIT_CANDIDATE_SELECTOR = 'p,div,span,[role="alert"],[role="status"],[data-gptlock-hard-limit-semantic]';
  const MAX_NOTICE_TEXT = 1_500;
  const REFRESH_MS = 300;

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function shouldTreatAsHardLimit({
    text = '',
    classifier = null,
    ownNotice = false,
    insideConversation = false,
    containsConversation = false,
  } = {}) {
    if (ownNotice || insideConversation || containsConversation || typeof classifier !== 'function') return false;
    const normalized = normalizeText(text);
    if (!normalized || normalized.length > MAX_NOTICE_TEXT) return false;
    return Boolean(classifier(normalized));
  }

  function decideDisplay({
    hardLimitVisible = false,
    historyMeasurementSource = '',
    fullHistoryAvailable = false,
  } = {}) {
    if (hardLimitVisible) {
      return Object.freeze({
        text: '0%',
        status: 'danger',
        source: 'chatgpt-visible-hard-limit',
        detail: '当前页面检测到 ChatGPT 自身的“对话长度上限”系统提示，因此本聊天的可继续长度以 ChatGPT 实际状态为准：0%。',
      });
    }
    if (historyMeasurementSource === 'dom-fallback' && !fullHistoryAvailable) {
      return Object.freeze({
        text: '未知',
        status: 'unknown',
        source: 'partial-dom-unknown',
        detail: '当前只能读取 ChatGPT 页面仍保留的可见消息，历史内容可能已被虚拟化或卸载，因此不显示伪精确的剩余百分比。',
      });
    }
    return null;
  }

  const api = Object.freeze({ normalizeText, shouldTreatAsHardLimit, decideDisplay });
  globalThis[KEY] = api;

  if (typeof document === 'undefined' || typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;

  let queued = false;
  let rootObserver = null;
  let observedRoot = null;
  let overriding = false;

  function visible(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function elementText(element) {
    return String(element?.innerText || element?.textContent || '');
  }

  function findVisibleHardLimit(budgetApi) {
    const classifier = budgetApi?.classifyConversationLengthLimitText;
    if (typeof classifier !== 'function') return null;

    const candidates = document.querySelectorAll(HARD_LIMIT_CANDIDATE_SELECTOR);
    for (const element of candidates) {
      if (!visible(element)) continue;
      const ownNotice = Boolean(element.closest(OWN_NOTICE_SELECTOR));
      const insideConversation = Boolean(element.closest(CONVERSATION_TURN_SELECTOR));
      const containsConversation = Boolean(element.querySelector?.(CONVERSATION_TURN_SELECTOR));
      if (!shouldTreatAsHardLimit({
        text: elementText(element),
        classifier,
        ownNotice,
        insideConversation,
        containsConversation,
      })) continue;
      return element;
    }
    return null;
  }

  function fullHistoryAvailable(budgetApi) {
    const source = budgetApi?.privateHistorySnapshot?.();
    return Boolean(source && Array.isArray(source.history) && source.history.length > 0);
  }

  function ensureUnknownStyle(root) {
    if (root.getElementById('gptlock-chat-length-truth-style')) return;
    const style = document.createElement('style');
    style.id = 'gptlock-chat-length-truth-style';
    style.textContent = '[data-source="context"][data-status="unknown"] .model-value{color:#e5e7eb}';
    root.append(style);
  }

  function currentRow() {
    const host = document.getElementById('gptlock-model-indicator-host');
    const root = host?.shadowRoot;
    const button = root?.querySelector('button');
    if (!root || !button) return { root: null, row: null };
    ensureUnknownStyle(root);
    let row = root.querySelector('[data-source="context"]');
    if (!row) {
      row = document.createElement('span');
      row.className = 'model-row';
      row.dataset.source = 'context';
      row.innerHTML = '<span class="model-key">聊天长度剩余</span><span class="model-value">未知</span>';
      button.append(row);
    }
    return { root, row };
  }

  function observeRoot(root) {
    if (!root || observedRoot === root) return;
    rootObserver?.disconnect();
    observedRoot = root;
    rootObserver = new MutationObserver(schedule);
    rootObserver.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  function applyDecision(row, decision, snapshot) {
    const key = row.querySelector('.model-key');
    const value = row.querySelector('.model-value');
    if (key && key.textContent !== '聊天长度剩余') key.textContent = '聊天长度剩余';
    if (value && value.textContent !== decision.text) value.textContent = decision.text;
    if (row.dataset.status !== decision.status) row.dataset.status = decision.status;
    if (row.dataset.remainingSource !== decision.source) row.dataset.remainingSource = decision.source;
    if (row.dataset.gptlockTruthAuthority !== '1') row.dataset.gptlockTruthAuthority = '1';
    const hash = globalThis.__GPTLOCK_CHAT_LENGTH_REMAINING_INDICATOR__?.diagnosticConversationHash?.(snapshot?.conversationKey);
    const scope = hash ? `\n统计范围：仅当前对话（${hash}）` : '';
    const detail = `聊天长度剩余：${decision.text}\n${decision.detail}${scope}`;
    if (row.title !== detail) row.title = detail;
    if (row.getAttribute('aria-label') !== detail) row.setAttribute('aria-label', detail);
  }

  function releaseOverride(row) {
    if (row?.dataset?.gptlockTruthAuthority !== '1') return;
    delete row.dataset.gptlockTruthAuthority;
    window.dispatchEvent(new CustomEvent('gptlock:context-budget', { detail: { reason: 'truth-authority-release' } }));
  }

  function reconcile() {
    queued = false;
    if (overriding) return;
    overriding = true;
    try {
      const budgetApi = globalThis.__GPTLOCK_CONTEXT_BUDGET__;
      const snapshot = budgetApi?.snapshot?.() || null;
      const { root, row } = currentRow();
      if (!root || !row || !snapshot) return;
      observeRoot(root);

      const hardLimitVisible = Boolean(findVisibleHardLimit(budgetApi));
      const historySource = String(snapshot.historyMeasurementSource || '');
      const decision = decideDisplay({
        hardLimitVisible,
        historyMeasurementSource: historySource,
        fullHistoryAvailable: fullHistoryAvailable(budgetApi),
      });

      if (decision) {
        applyDecision(row, decision, snapshot);
      } else {
        releaseOverride(row);
      }
    } finally {
      overriding = false;
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(reconcile);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['role', 'style', 'class', 'hidden'],
  });
  window.addEventListener('gptlock:context-budget', schedule);
  window.addEventListener('gptlock:context-hard-limit-learned', schedule);
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
  document.addEventListener('visibilitychange', schedule);
  window.setInterval(reconcile, REFRESH_MS);
  reconcile();
})();
