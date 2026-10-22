(() => {
  // Runs at document_start, before ChatGPT hydrates its composer. Metadata only:
  // no DOM contents, cookies, request bodies, headers or page JavaScript hooks.
  const startedAt = Number.isFinite(performance.timeOrigin) ? Math.round(performance.timeOrigin) : Date.now();
  const navigation = performance.getEntriesByType?.('navigation')?.[0];
  const navigationType = navigation?.type || 'unknown';
  const emit = (stage, persisted = false) => {
    try {
      void chrome.runtime.sendMessage({
        type: 'GPTLOCK_ASTRA_ORIGIN_DOCUMENT_EVENT',
        stage,
        documentTimeOrigin: startedAt,
        sinceNavigationMs: Math.max(0, Math.round(performance.now())),
        navigationType,
        readyState: document.readyState,
        persisted: persisted === true,
      }).catch(() => {});
    } catch {}
  };
  emit('document_start');
  document.addEventListener('DOMContentLoaded', () => emit('dom_content_loaded'), { once: true });
  window.addEventListener('pageshow', (event) => emit('pageshow', event.persisted), { once: true });
  window.addEventListener('load', () => emit('window_load'), { once: true });
})();
