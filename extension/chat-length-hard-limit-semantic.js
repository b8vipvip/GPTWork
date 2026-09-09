(() => {
  const KEY = '__GPTLOCK_CHAT_LENGTH_HARD_LIMIT_SEMANTIC__';
  if (globalThis[KEY]) return;

  const OWN_NOTICE_SELECTOR = '#gptlock-context-warning-host,#gptlock-context-learning-toast,#gptlock-context-hard-limit-toast';
  const CONVERSATION_TURN_SELECTOR = '[data-message-author-role],article[data-testid^="conversation-turn-"]';
  const PRIMARY_SELECTOR = 'p,[role="alert"],[role="status"],[data-gptlock-hard-limit-semantic]';
  const HARD_LIMIT_ACTION_PATTERN = /开始新(?:对话|聊天)|新建(?:对话|聊天)|start (?:a )?new chat|new chat/i;
  const MARKER = 'data-gptlock-hard-limit-semantic';
  const MAX_NOTICE_TEXT = 1_500;

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function shouldNormalizeCandidate({
    text = '',
    classifier = null,
    insideConversation = false,
    containsConversation = false,
    ownNotice = false,
  } = {}) {
    if (ownNotice || insideConversation || containsConversation || typeof classifier !== 'function') return false;
    const normalized = normalizeText(text);
    if (!normalized || normalized.length > MAX_NOTICE_TEXT) return false;
    return Boolean(classifier(normalized));
  }

  const api = Object.freeze({ normalizeText, shouldNormalizeCandidate });
  globalThis[KEY] = api;

  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;

  function classifier() {
    const candidate = globalThis.__GPTLOCK_CONTEXT_BUDGET__?.classifyConversationLengthLimitText;
    return typeof candidate === 'function' ? candidate : null;
  }

  function elementText(element) {
    return String(element?.innerText || element?.textContent || '');
  }

  function candidateMatches(element, classify) {
    if (!element) return false;
    return shouldNormalizeCandidate({
      text: elementText(element),
      classifier: classify,
      insideConversation: Boolean(element.closest(CONVERSATION_TURN_SELECTOR)),
      containsConversation: Boolean(element.querySelector?.(CONVERSATION_TURN_SELECTOR)),
      ownNotice: Boolean(element.closest(OWN_NOTICE_SELECTOR)),
    });
  }

  function reconcile() {
    const classify = classifier();
    if (!classify) return;
    const matched = new Set();

    for (const element of document.querySelectorAll(PRIMARY_SELECTOR)) {
      if (candidateMatches(element, classify)) matched.add(element);
    }

    // Current ChatGPT can put the text in a plain div/span beside a “New chat” action.
    // Walk upward from that action rather than scanning every generic container in the page.
    for (const action of document.querySelectorAll('button,a')) {
      if (!HARD_LIMIT_ACTION_PATTERN.test(normalizeText(elementText(action)))) continue;
      let container = action.parentElement;
      for (let depth = 0; depth < 7 && container; depth += 1, container = container.parentElement) {
        if (candidateMatches(container, classify)) {
          matched.add(container);
          break;
        }
      }
    }

    for (const element of matched) {
      if (!element.getAttribute('role')) {
        element.setAttribute('role', 'status');
        element.setAttribute(MARKER, 'role-added');
      } else if (!element.getAttribute(MARKER)) {
        element.setAttribute(MARKER, 'matched');
      }
    }

    for (const element of document.querySelectorAll(`[${MARKER}]`)) {
      if (matched.has(element)) continue;
      const marker = element.getAttribute(MARKER);
      element.removeAttribute(MARKER);
      if (marker === 'role-added' && element.getAttribute('role') === 'status') element.removeAttribute('role');
    }
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      reconcile();
    });
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['role'],
  });
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
  reconcile();
})();
