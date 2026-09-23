const params = new URLSearchParams(location.search);
const requested = String(params.get('mode') || 'normal').toLowerCase();
const allowed = new Set(['normal', 'cdp_off', 'content_off', 'high_level_off', 'runtime_off']);
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

async function runDeterministicBrowserWorkload() {
  try {
    const controlTab = await chrome.tabs.getCurrent();
    const tabs = (await chrome.tabs.query({ windowId: controlTab?.windowId, url: 'https://chatgpt.com/*' }))
      .filter((tab) => tab.id && tab.id !== controlTab?.id)
      .sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0));
    const target = tabs[0];
    if (!target?.id) return { ok: false, reason: 'chatgpt_tab_missing' };
    const actions = [];
    // Exercise Chrome-level tab activation as a separate workload dimension.
    if (tabs[1]?.id) {
      await chrome.tabs.update(tabs[1].id, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 180));
      actions.push('tab-switch-away');
    }
    await chrome.tabs.update(target.id, { active: true });
    actions.push('tab-switch-target');
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: target.id },
      world: 'ISOLATED',
      func: async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (element) => {
          const rect = element?.getBoundingClientRect?.();
          if (!element?.isConnected || !rect || rect.width <= 0 || rect.height <= 0) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none'
            && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
        };
        const trace = [];
        const startY = scrollY;
        const maxY = Math.max(0, document.documentElement.scrollHeight - innerHeight);
        // Multiple scroll positions, not one repeated coordinate.
        for (const ratio of [0.15, 0.72, 0.38, 0.9, 0.05]) {
          window.scrollTo({ top: Math.round(maxY * ratio), behavior: 'instant' });
          trace.push(`scroll:${ratio}`);
          await sleep(140);
        }
        // Pointer/mouse workload across several visible controls and coordinates.
        const controls = [...document.querySelectorAll('button,[role="button"],textarea,[contenteditable="true"],a')]
          .filter(visible).slice(0, 8);
        for (const [index, element] of controls.entries()) {
          const rect = element.getBoundingClientRect();
          for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.5], [0.5, 0.8]]) {
            element.dispatchEvent(new MouseEvent('mousemove', {
              bubbles: true,
              clientX: rect.left + rect.width * fx,
              clientY: rect.top + rect.height * fy,
            }));
          }
          trace.push(`pointer-control:${index}`);
          await sleep(55);
        }
        const composer = [...document.querySelectorAll('textarea,[contenteditable="true"]')].find(visible);
        if (composer) {
          composer.focus({ preventScroll: true });
          composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true }));
          composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true }));
          composer.blur();
          trace.push('composer-focus-key-blur');
        }
        const trigger = [...document.querySelectorAll(
          '[data-testid*="model"],button[aria-haspopup="menu"],button[aria-haspopup="dialog"]'
        )].find((element) => visible(element) && /gpt|model|模型|thinking|思考/i.test(
          [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')].filter(Boolean).join(' ')
        ));
        if (trigger) {
          for (let cycle = 0; cycle < 2; cycle += 1) {
            trigger.click();
            trace.push(`picker-open:${cycle}`);
            await sleep(180);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
            trace.push(`picker-close:${cycle}`);
            await sleep(140);
          }
        }
        window.scrollTo({ top: startY, behavior: 'instant' });
        trace.push('scroll-restore');
        return { ok: true, actions: trace };
      },
    });
    return { ...(result || { ok: true }), chromeActions: actions };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
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
    const workload = await runDeterministicBrowserWorkload();
    await chrome.storage.local.set({
      gptworkJankSyntheticWorkloadLast: {
        captureId: captureId || null,
        label,
        mode,
        completedAt: new Date().toISOString(),
        ...workload,
      },
    }).catch(() => {});
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
