(() => {
  const KEY = '__GPTLOCK_CHAT_LENGTH_HARD_LIMIT_SEMANTIC__';
  if (globalThis[KEY]) return;

  const OWN_NOTICE_SELECTOR = '#gptlock-context-warning-host,#gptlock-context-learning-toast,#gptlock-context-hard-limit-toast';
  const CONVERSATION_TURN_SELECTOR = '[data-message-author-role],article[data-testid^="conversation-turn-"]';
  const MARKER = 'data-gptlock-hard-limit-semantic';

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function shouldNormalizeCandidate({ text = '', classifier = null, insideConversation = false, ownNotice = false } = {}) {
    if (ownNotice || insideConversation || typeof classifier !== 'function') return false;
    return Boolean(classifier(normalizeText(text)));
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

    for (const element of document.querySelectorAll(`p,[role="alert"],[role="status"],[${MARKER}]`)) {
      const ownNotice = Boolean(element.closest(OWN_NOTICE_SELECTOR));
      const insideConversation = Boolean(element.closest(CONVERSATION_TURN_SELECTOR));
      const matches = shouldNormalizeCandidate({
        text: elementText(element),
        classifier: classify,
        insideConversation,
        ownNotice,
      });

      if (matches) {
        // The remaining-length indicator deliberately requires a semantic system notice
        // or a nearby new-chat action. ChatGPT's current hard-limit banner can be a plain
        // out-of-turn <p>, so normalize that system chrome to status without touching
        // quoted/user content inside conversation turns.
        if (!element.getAttribute('role')) {
          element.setAttribute('role', 'status');
          element.setAttribute(MARKER, 'role-added');
        }
      } else if (element.getAttribute(MARKER) === 'role-added') {
        element.removeAttribute(MARKER);
        if (element.getAttribute('role') === 'status') element.removeAttribute('role');
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
