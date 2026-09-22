const params = new URLSearchParams(location.search);
const requested = String(params.get('mode') || 'normal').toLowerCase();
const allowed = new Set(['normal', 'cdp_off', 'content_off', 'high_level_off']);
const mode = allowed.has(requested) ? requested : 'normal';
const status = document.getElementById('status');

(async () => {
  const requestedAt = new Date().toISOString();
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GPTWORK_SET_JANK_ISOLATION',
      mode,
      source: 'windows-jank-ab',
    });
    if (!response?.ok) throw new Error(response?.error || 'isolation_change_failed');
    status.textContent = `Applied: ${mode}`;
    document.title = `GPTWork Jank A/B: ${mode}`;
    await chrome.storage.local.set({
      gptworkJankControlLast: {
        mode,
        requestedAt,
        appliedAt: new Date().toISOString(),
        result: response.result || null,
      },
    });
    setTimeout(() => chrome.tabs.getCurrent((tab) => {
      if (tab?.id) chrome.tabs.remove(tab.id).catch?.(() => {});
    }), 500);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.textContent = `Failed: ${mode}: ${message}`;
    document.title = `GPTWork Jank A/B failed: ${mode}`;
    await chrome.storage.local.set({
      gptworkJankControlLast: {
        mode,
        requestedAt,
        failedAt: new Date().toISOString(),
        error: message,
      },
    }).catch(() => {});
  }
})();
