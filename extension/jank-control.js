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

async function runDeterministicBrowserWorkload() {
  try {
    const controlTab = await chrome.tabs.getCurrent();
    const tabs = await chrome.tabs.query({ windowId: controlTab?.windowId, url: 'https://chatgpt.com/*' });
    const target = tabs
      .filter((tab) => tab.id && tab.id !== controlTab?.id)
      .sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
    if (!target?.id) return { ok: false, reason: 'chatgpt_tab_missing' };
    await chrome.tabs.update(target.id, { active: true });
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
        const actions = [];
        const startY = scrollY;
        for (let cycle = 0; cycle < 3; cycle += 1) {
          window.scrollBy({ top: 420, behavior: 'instant' });
          actions.push('scroll-down');
          await sleep(180);
          window.scrollBy({ top: -260, behavior: 'instant' });
          actions.push('scroll-up');
          await sleep(180);
          const composer = [...document.querySelectorAll('textarea,[contenteditable="true"]')].find(visible);
          if (composer) {
            composer.focus({ preventScroll: true });
            composer.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 8, clientY: 8 }));
            actions.push('composer-focus-pointer');
          }
          const trigger = [...document.querySelectorAll(
            '[data-testid*="model"],button[aria-haspopup="menu"],button[aria-haspopup="dialog"]'
          )].find((element) => visible(element) && /gpt|model|模型|thinking|思考/i.test(
            [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')].filter(Boolean).join(' ')
          ));
          if (trigger) {
            trigger.click();
            actions.push('picker-open');
            await sleep(220);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
            actions.push('picker-close');
          }
          await sleep(220);
        }
        window.scrollTo({ top: startY, behavior: 'instant' });
        actions.push('scroll-restore');
        return { ok: true, actions };
      },
    });
    return result || { ok: true };
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
