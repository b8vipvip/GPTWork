const params = new URLSearchParams(location.search);
const requested = String(params.get('mode') || 'normal').toLowerCase();
const allowed = new Set(['normal', 'cdp_off', 'content_off', 'high_level_off']);
const mode = allowed.has(requested) ? requested : 'normal';
const status = document.getElementById('status');
const label = String(params.get('label') || mode).slice(0, 80);
const captureId = String(params.get('captureId') || '').slice(0, 120);

function safePart(value) {
  return String(value || 'unknown').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120) || 'unknown';
}

function downloadSnapshot(snapshot) {
  if (!snapshot?.captureId || !snapshot?.label) return;
  try {
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `GPTWork-Jank-Phase-${safePart(snapshot.captureId)}-${safePart(snapshot.label)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1500);
  } catch {}
}

(async () => {
  const requestedAt = new Date().toISOString();
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GPTWORK_SET_JANK_ISOLATION',
      mode,
      label,
      captureId: captureId || null,
      source: 'windows-jank-ab',
    });
    if (!response?.ok) throw new Error(response?.error || 'isolation_change_failed');
    if (response.result?.completedPhase) downloadSnapshot(response.result.completedPhase);
    status.textContent = `Applied: ${label} / ${mode}`;
    document.title = `GPTWork Jank A/B: ${label}`;
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
