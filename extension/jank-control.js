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

async function downloadSnapshot(snapshot) {
  if (!snapshot?.captureId || !snapshot?.label) return false;
  let href = null;
  try {
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    href = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: href,
      filename: `GPTWork-Jank-Phase-${safePart(snapshot.captureId)}-${safePart(snapshot.label)}.json`,
      conflictAction: 'overwrite',
      saveAs: false,
    });
    return true;
  } catch {
    return false;
  } finally {
    if (href) setTimeout(() => URL.revokeObjectURL(href), 5000);
  }
}

async function restoreChatFocus() {
  try {
    const controlTab = await chrome.tabs.getCurrent();
    const tabs = await chrome.tabs.query({
      windowId: controlTab?.windowId,
      url: 'https://chatgpt.com/*',
    });
    const target = tabs
      .filter((tab) => tab.id && tab.id !== controlTab?.id)
      .sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
    if (target?.id) await chrome.tabs.update(target.id, { active: true });
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
    if (response.result?.completedPhase) await downloadSnapshot(response.result.completedPhase);
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
    await restoreChatFocus();
    setTimeout(() => chrome.tabs.getCurrent((tab) => {
      if (tab?.id) chrome.tabs.remove(tab.id).catch?.(() => {});
    }), 50);
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
