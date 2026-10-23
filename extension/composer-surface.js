// Shared, read-only identity for the active ChatGPT composer.
// The same owner is used by debug send and send-button compatibility; it never
// selects an arbitrary search field, hidden editor, modal or sidebar input.
(() => {
  const PRIMARY_SELECTORS = [
    '#prompt-textarea',
    'textarea[data-testid*="prompt"]',
    '[contenteditable="true"][data-testid*="composer"]',
    '[contenteditable="plaintext-only"][data-testid*="composer"]',
    '.ProseMirror[contenteditable="true"]',
    '.ProseMirror[contenteditable="plaintext-only"]',
  ];
  const CHAT_HINT = /chatgpt|message|prompt|ask anything|ask a question|询问|提问|发送消息|输入消息|聊天|发送给/i;
  const EDITOR_SELECTOR = 'textarea,[contenteditable],[role="textbox"],input[type="text"]';
  const EXCLUDE_SELECTOR = 'aside,nav,header,[role="dialog"],[role="search"],[aria-hidden="true"],[inert]';

  function isEditable(element) {
    if (!element || element.disabled || element.readOnly
      || element.getAttribute?.('aria-disabled') === 'true') return false;
    const tag = String(element.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') return element.type === 'text' || !element.type;
    const attr = element.getAttribute?.('contenteditable');
    return attr === 'true' || attr === 'plaintext-only' || element.isContentEditable === true;
  }

  function visible(element) {
    if (!element?.isConnected || element.closest?.(EXCLUDE_SELECTOR)) return false;
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0
      || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function qualified(element) {
    return isEditable(element) && visible(element);
  }

  function hasChatHint(element) {
    const name = ['placeholder', 'data-placeholder', 'aria-placeholder', 'aria-label',
      'data-testid', 'id'].map((key) => element.getAttribute?.(key) || '').join(' ');
    return CHAT_HINT.test(name);
  }

  function uniqueEditors(scope) {
    const editors = [...scope.querySelectorAll(EDITOR_SELECTOR)].filter(qualified);
    return [...new Set(editors)];
  }

  function activeComposer() {
    for (const selector of PRIMARY_SELECTORS) {
      const match = [...document.querySelectorAll(selector)].find(qualified);
      if (match) return match;
    }
    // A redesigned ChatGPT composer can be an unlabeled contenteditable=plaintext-only
    // textbox. Accept only an unambiguous editor in the chat's own form.
    const scopes = [...document.querySelectorAll('main form, form[data-testid*="composer"],main [data-testid*="composer"]')];
    for (const scope of scopes) {
      if (!visible(scope)) continue;
      const editors = uniqueEditors(scope);
      if (editors.length === 1) return editors[0];
      const hinted = editors.filter(hasChatHint);
      if (hinted.length === 1) return hinted[0];
    }
    // If ChatGPT removed <form>, permit only one semantically chat-labeled
    // editor inside main. Never guess among multiple unlabelled editors.
    const main = document.querySelector('main');
    if (main) {
      const hinted = uniqueEditors(main).filter(hasChatHint);
      if (hinted.length === 1) return hinted[0];
    }
    return null;
  }

  function diagnosticSnapshot() {
    // Numeric DOM topology only. Never export draft text, conversation title,
    // the editor's value or arbitrary page text.
    const editors = [...document.querySelectorAll(EDITOR_SELECTOR)];
    const visibleEditable = editors.filter(qualified);
    return {
      documentReady: document.readyState,
      documentVisible: document.visibilityState === 'visible',
      primaryMatched: PRIMARY_SELECTORS.reduce((n, selector) =>
        n + document.querySelectorAll(selector).length, 0),
      mainForms: document.querySelectorAll('main form').length,
      visibleEditable: visibleEditable.length,
      chatHinted: visibleEditable.filter(hasChatHint).length,
    };
  }

  Object.defineProperty(globalThis, 'GPTWorkComposerSurfaceV1', {
    value: Object.freeze({ getActiveComposer: activeComposer, diagnosticSnapshot }),
    configurable: false,
    writable: false,
  });
})();
