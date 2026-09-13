(() => {
  const MASTER_KEY = 'gptworkEnabledLocal';
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
    let runtimeError = null;
    try { runtimeError = chrome.runtime.lastError; } catch {}
    masterEnabled = !runtimeError && stored?.[MASTER_KEY] === true;
    masterResolved = true;
    maintainUiPolicy();
  });
})();
