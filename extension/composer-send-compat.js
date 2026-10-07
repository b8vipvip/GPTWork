(() => {
  const MARKER = 'gptworkSendCompat';
  const PROMPT_SELECTORS = [
    '#prompt-textarea',
    'textarea[data-testid*="prompt"]',
    '[contenteditable="true"][data-testid*="composer"]',
    '.ProseMirror[contenteditable="true"]',
  ];

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect?.();
    const style = getComputedStyle(element);
    return Boolean(rect && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden');
  }

  function promptElement() {
    return PROMPT_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find((element) => visible(element)) || null;
  }

  function promptHasText(prompt) {
    if (!prompt) return false;
    const value = typeof prompt.value === 'string' ? prompt.value : (prompt.innerText || prompt.textContent || '');
    return String(value || '').trim().length > 0;
  }

  const NON_SEND_ACTION = /open\s+(?:the\s+)?desktop\s+app|desktop\s+app|打开桌面应用|桌面应用|codex(?:\/|\s|$)|deeplink|download\s+app|下载(?:桌面)?应用/i;

  function buttonDescriptor(button) {
    const linked = button?.closest?.('a[href]');
    return [
      button?.getAttribute?.('aria-label'),
      button?.getAttribute?.('title'),
      button?.getAttribute?.('data-testid'),
      button?.getAttribute?.('name'),
      button?.getAttribute?.('formaction'),
      linked?.getAttribute?.('href'),
      button?.textContent,
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function excludedButton(button) {
    const descriptor = buttonDescriptor(button);
    const popup = String(button.getAttribute('aria-haspopup') || '').trim().toLowerCase();
    return /stop|停止|voice|语音|dictat|听写|record|录音|attach|upload|file|附件|添加|model|模型|reason|think|思考|select\s+(?:project|workspace)|choose\s+(?:project|workspace)|选择项目|選擇項目|选择工作区|選擇工作區/.test(descriptor)
      || NON_SEND_ACTION.test(descriptor)
      || (popup && popup !== 'false');
  }

  function clearUnsafeCompatMarker(button) {
    if (!button || button.dataset?.[MARKER] !== 'true' || !excludedButton(button)) return false;
    const originalTestId = button.dataset.modelproOriginalTestid;
    if (originalTestId) {
      button.setAttribute('data-testid', originalTestId);
      delete button.dataset.modelproOriginalTestid;
    } else if (['send-button', 'composer-submit-button'].includes(String(button.getAttribute('data-testid') || ''))) {
      button.removeAttribute('data-testid');
    }
    delete button.dataset[MARKER];
    return true;
  }

  function scoreButton(button, promptHasValue) {
    if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true' || excludedButton(button)) return -1;
    const descriptor = [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.getAttribute('data-testid'),
      button.getAttribute('name'),
    ].filter(Boolean).join(' ').toLowerCase();
    let score = 0;
    if (/send-button|composer-submit-button/.test(descriptor)) score += 140;
    if (/(^|\s)(send|发送|提交)(\s|$)/i.test(descriptor)) score += 110;
    if (/send|发送|submit|提交/i.test(descriptor)) score += 90;
    if (String(button.type || '').toLowerCase() === 'submit') score += 75;
    if (/composer-primary|bg-composer-primary/.test(String(button.className || ''))) score += 35;
    if (promptHasValue) score += 10;
    const rect = button.getBoundingClientRect?.();
    if (rect) score += Math.max(0, Math.min(20, rect.x / 100));
    return score;
  }

  function annotateSendButton() {
    const prompt = promptElement();
    if (!prompt) return null;
    const form = prompt.closest('form');
    const scope = form || prompt.parentElement;
    if (!scope) return null;
    const hasText = promptHasText(prompt);
    const buttons = [...scope.querySelectorAll('button')];
    // ChatGPT can repurpose a composer control after switching into Work. If a
    // GPTWork-annotated button becomes an "Open desktop app" / Codex deeplink CTA,
    // remove the compatibility marker before any send-button scoring happens.
    for (const button of buttons) clearUnsafeCompatMarker(button);
    let best = null;
    let bestScore = -1;
    for (const button of buttons) {
      const score = scoreButton(button, hasText);
      if (score > bestScore) {
        best = button;
        bestScore = score;
      }
    }
    // The redesigned Chat composer can expose an unlabeled icon-only submit control.
    // Keep the compatibility fallback, but only for a non-popup button in the
    // composer's trailing action zone. Work exposes project/file/plugin controls in
    // the leading rail; those must never be promoted to send-button.
    if ((!best || bestScore < 45) && hasText) {
      const scopeRect = scope.getBoundingClientRect?.();
      const trailingBoundary = scopeRect
        ? scopeRect.right - Math.max(180, Math.min(260, scopeRect.width * 0.34))
        : Number.NEGATIVE_INFINITY;
      const fallback = buttons
        .filter((button) => {
          if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true' || excludedButton(button)) return false;
          const rect = button.getBoundingClientRect?.();
          return !scopeRect || (rect && rect.right >= trailingBoundary);
        })
        .sort((a, b) => (b.getBoundingClientRect?.().x || 0) - (a.getBoundingClientRect?.().x || 0))[0] || null;
      if (fallback) best = fallback;
    }
    if (!best) return null;
    const existingTestId = best.getAttribute('data-testid');
    if (existingTestId && existingTestId !== 'send-button' && existingTestId !== 'composer-submit-button') {
      best.dataset.modelproOriginalTestid = existingTestId;
    }
    best.setAttribute('data-testid', 'send-button');
    best.dataset[MARKER] = 'true';
    return best;
  }

  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      annotateSendButton();
    }, 40);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener('input', schedule, true);
  document.addEventListener('change', schedule, true);
  window.setInterval(annotateSendButton, 250);
  annotateSendButton();
})();
