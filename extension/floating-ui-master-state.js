(() => {
  const MASTER_KEY = 'gptworkEnabledLocal';
  const GPTWORK_MESSAGE_PREFIX = 'GPTLOCK_';
  const RECENT_REQUEST_MARKER = /\s*·\s*最近请求/g;
  const FLOATING_HOST_IDS = [
    'gptlock-indicator-host',
    'gptlock-model-indicator-host',
    'gptlock-notice-host',
  ];

  let masterEnabled = false;
  let masterResolved = false;
  const observedShadows = new WeakSet();

  function removeFloatingUi() {
    for (const id of FLOATING_HOST_IDS) document.getElementById(id)?.remove();
  }

  function stripRecentRequestCopy(root) {
    if (!root?.querySelectorAll) return;
    for (const node of root.querySelectorAll('.model-value')) {
      const next = String(node.textContent || '').replace(RECENT_REQUEST_MARKER, '').trim();
      if (next !== node.textContent) node.textContent = next;
    }
    for (const node of root.querySelectorAll('[title]')) {
      const current = node.getAttribute('title') || '';
      const next = current.replace(RECENT_REQUEST_MARKER, '');
      if (next !== current) node.setAttribute('title', next);
    }
  }

  function watchModelIndicator() {
    const host = document.getElementById('gptlock-model-indicator-host');
    const root = host?.shadowRoot;
    if (!root) return;
    stripRecentRequestCopy(root);
    if (observedShadows.has(root)) return;
    observedShadows.add(root);
    new MutationObserver(() => stripRecentRequestCopy(root)).observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['title'],
    });
  }

  function maintainUiPolicy() {
    if (masterResolved && !masterEnabled) {
      removeFloatingUi();
      return;
    }
    watchModelIndicator();
  }

  function disabledResponse(message) {
    if (message?.type === 'GPTLOCK_GET_STATE') {
      return {
        ok: true,
        data: {
          policy: null,
          settings: { enabled: false },
          nativeStatus: { connected: false },
          tabState: null,
          accountWindowAllowed: false,
        },
      };
    }
    return { ok: true, data: null };
  }

  // Content scripts share one isolated world. Suppress GPTWork runtime chatter while
  // the master switch is off so periodic observers cannot keep waking the service worker.
  try {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => {
      if (!masterResolved || masterEnabled || !String(message?.type || '').startsWith(GPTWORK_MESSAGE_PREFIX)) {
        return originalSendMessage(message, ...args);
      }
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const response = disabledResponse(message);
      if (callback) {
        queueMicrotask(() => callback(response));
        return undefined;
      }
      return Promise.resolve(response);
    };
  } catch {
    // The visual and background hard-stop paths still apply if the API is read-only.
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'GPTLOCK_MASTER_RUNTIME_STATE') return false;
    masterEnabled = message.enabled === true;
    masterResolved = true;
    maintainUiPolicy();
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[MASTER_KEY]) return;
    masterEnabled = changes[MASTER_KEY].newValue === true;
    masterResolved = true;
    maintainUiPolicy();
  });

  const pageObserver = new MutationObserver(maintainUiPolicy);
  pageObserver.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.local.get(MASTER_KEY, (stored) => {
    masterEnabled = !chrome.runtime.lastError && stored?.[MASTER_KEY] === true;
    masterResolved = true;
    maintainUiPolicy();
  });
})();
