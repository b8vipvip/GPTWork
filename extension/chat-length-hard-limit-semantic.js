(() => {
  const KEY = '__GPTLOCK_CHAT_LENGTH_HARD_LIMIT_SEMANTIC__';
  if (globalThis[KEY]) return;

  const OWN_NOTICE_SELECTOR = '#gptlock-context-warning-host,#gptlock-context-learning-toast,#gptlock-context-hard-limit-toast';
  const CONVERSATION_TURN_SELECTOR = '[data-message-author-role],article[data-testid^="conversation-turn-"]';
  const CANDIDATE_SELECTOR = 'p,div,span,[role="alert"],[role="status"],[data-gptlock-hard-limit-semantic]';
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

  function reconcile() {
    const classify = classifier();
    if (!classify) return;

    for (const element of document.querySelectorAll(CANDIDATE_SELECTOR)) {
      const ownNotice = Boolean(element.closest(OWN_NOTICE_SELECTOR));
      const insideConversation = Boolean(element.closest(CONVERSATION_TURN_SELECTOR));
      const containsConversation = Boolean(element.querySelector?.(CONVERSATION_TURN_SELECTOR));
      const matches = shouldNormalizeCandidate({
        text: elementText(element),
        classifier: classify,
        insideConversation,
        containsConversation,
        ownNotice,
      });

      if (matches) {
        // ChatGPT may render the terminal conversation-length notice as a plain p/div/span.
        // Mark only compact system chrome that is completely outside normal conversation turns.
        if (!element.getAttribute('role')) {
          element.setAttribute('role', 'status');
          element.setAttribute(MARKER, 'role-added');
        } else {
          element.setAttribute(MARKER, 'matched');
        }
      } else if (element.getAttribute(MARKER)) {
        const marker = element.getAttribute(MARKER);
        element.removeAttribute(MARKER);
        if (marker === 'role-added' && element.getAttribute('role') === 'status') element.removeAttribute('role');
      }
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
