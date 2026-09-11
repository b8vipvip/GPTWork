(() => {
  const SENTINEL = '__GPTWORK_LOCAL_ERROR_CAPTURE_V1__';
  if (globalThis[SENTINEL]) return;
  globalThis[SENTINEL] = true;

  const STORAGE_KEY = 'runtimeLogs';
  const LIMIT = 2000;
  let queue = Promise.resolve();

  function clip(value, max = 2000) {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…[truncated:${text.length}]` : text;
  }

  function append(level, event, details = {}) {
    const entry = {
      id: `log:content-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timestamp: new Date().toISOString(),
      level,
      component: 'content-runtime',
      event,
      details: {
        url: `${location.origin}${location.pathname}`,
        ...details,
      },
    };
    queue = queue.catch(() => {}).then(async () => {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const logs = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
      await chrome.storage.local.set({ [STORAGE_KEY]: [...logs, entry].slice(-LIMIT) });
    });
  }

  window.addEventListener('error', (event) => {
    append('error', 'uncaught_error', {
      message: clip(event.message),
      filename: clip(event.filename, 500),
      line: Number(event.lineno || 0),
      column: Number(event.colno || 0),
      stack: clip(event.error?.stack || ''),
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    append('error', 'unhandled_rejection', {
      message: clip(reason?.message || reason),
      stack: clip(reason?.stack || ''),
    });
  });

  append('info', 'content_context_started', {
    readyState: document.readyState,
    extensionVersion: chrome.runtime.getManifest?.().version || null,
  });
})();
