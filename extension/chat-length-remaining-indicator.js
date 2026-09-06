(() => {
  const KEY = '__GPTLOCK_CHAT_LENGTH_REMAINING_INDICATOR__';
  if (globalThis[KEY]) return;

  const MODEL_CONTEXT_WINDOWS = Object.freeze([
    { pattern: /^gpt-5\.6(?:-|$)/, tokens: 1_050_000, source: 'openai-api-model-window' },
    { pattern: /^gpt-5\.5(?:-|$)/, tokens: 1_050_000, source: 'openai-api-model-window' },
    { pattern: /^gpt-5\.4-(?:mini|nano)(?:-|$)/, tokens: 400_000, source: 'openai-api-model-window' },
    { pattern: /^gpt-5\.4(?:-|$)/, tokens: 1_050_000, source: 'openai-api-model-window' },
  ]);
  const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
  const SAFETY_BUDGET_RATIO = 0.88;
  const HARD_LIMIT_SANITY_RATIO = 0.25;
  const HARD_LIMIT_SANITY_MIN_TOKENS = 32_000;
  const MESSAGE_OVERHEAD_TOKENS = 14;
  const IMAGE_TOKEN_ESTIMATE = 1_200;
  const ATTACHMENT_TOKEN_ESTIMATE = 4_000;
  const MAX_ADAPTIVE_LIMIT_TOKENS = 16_000_000;
  const REFRESH_MS = 750;
  const DIAGNOSTIC_MIN_INTERVAL_MS = 5_000;
  const HARD_LIMIT_ACTION_PATTERN = /开始新(?:对话|聊天)|新建(?:对话|聊天)|start (?:a )?new chat|new chat/i;
  const COMPOSER_SELECTORS = [
    '#prompt-textarea',
    'textarea[data-testid*="prompt"]',
    '[contenteditable="true"][data-testid*="composer"]',
    '.ProseMirror[contenteditable="true"]',
  ];

  function clampPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(100, Math.max(0, number));
  }

  function formatPercent(value) {
    const percent = clampPercent(value);
    if (percent === 0 || percent === 100) return `${Math.round(percent)}%`;
    return `${percent.toFixed(1)}%`;
  }

  function normalizeModelId(value) {
    const model = String(value ?? '').trim().toLowerCase();
    if (!model) return null;
    if (
      model === 'gpt-5.6-sol-wm'
      || model === 'gpt-5-6'
      || model === 'gpt-5-6-thinking'
    ) return 'gpt-5.6-sol';
    return /^[a-z0-9._:-]{1,128}$/.test(model) ? model : null;
  }

  function contextWindowForModel(value) {
    const model = normalizeModelId(value);
    if (model) {
      const matched = MODEL_CONTEXT_WINDOWS.find(({ pattern }) => pattern.test(model));
      if (matched) return { model, tokens: matched.tokens, source: matched.source };
    }
    return { model, tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'conservative-fallback' };
  }

  function estimateTextTokens(value) {
    const text = String(value ?? '');
    if (!text) return 0;
    let cjk = 0;
    let ascii = 0;
    let emoji = 0;
    let other = 0;
    let lineBreaks = 0;

    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (char === '\n') lineBreaks += 1;
      if (
        (code >= 0x3400 && code <= 0x9fff)
        || (code >= 0x3040 && code <= 0x30ff)
        || (code >= 0xac00 && code <= 0xd7af)
      ) {
        cjk += 1;
      } else if (
        (code >= 0x1f000 && code <= 0x1faff)
        || (code >= 0x2600 && code <= 0x27bf)
      ) {
        emoji += 1;
      } else if (code <= 0x7f) {
        ascii += 1;
      } else if (!/\s/u.test(char)) {
        other += 1;
      }
    }

    return Math.max(1, Math.ceil(
      (cjk * 1.12)
      + (ascii / 3.65)
      + (emoji * 2.2)
      + (other * 1.35)
      + (lineBreaks * 0.18)
    ));
  }

  function boundedCount(value, max = 32) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.min(max, Math.floor(number));
  }

  function estimatePartTokens(part = {}) {
    const text = typeof part?.text === 'string' ? part.text : '';
    const images = boundedCount(part?.images);
    const attachments = boundedCount(part?.attachments);
    if (!text && images === 0 && attachments === 0) return 0;
    return estimateTextTokens(text)
      + (images * IMAGE_TOKEN_ESTIMATE)
      + (attachments * ATTACHMENT_TOKEN_ESTIMATE)
      + MESSAGE_OVERHEAD_TOKENS;
  }

  function clampAdaptiveLimit(value) {
    return Math.min(MAX_ADAPTIVE_LIMIT_TOKENS, Math.max(0, Math.ceil(Number(value) || 0)));
  }

  function reserveTokensForWindow(contextLimitTokens) {
    return Math.min(64_000, Math.max(8_192, Math.round(contextLimitTokens * 0.04)));
  }

  function hardLimitSanityFloor(contextLimitTokens = DEFAULT_CONTEXT_WINDOW_TOKENS) {
    const nominalLimit = Math.max(16_000, Number(contextLimitTokens) || DEFAULT_CONTEXT_WINDOW_TOKENS);
    const baseSafeLimit = Math.floor(nominalLimit * SAFETY_BUDGET_RATIO);
    return Math.max(HARD_LIMIT_SANITY_MIN_TOKENS, Math.floor(baseSafeLimit * HARD_LIMIT_SANITY_RATIO));
  }

  function credibleHardLimitUpperBound({ profile = null, contextLimitTokens, currentTokens = 0 } = {}) {
    if (!profile || profile.hardLimitTokenCapUsable !== true) return 0;
    if (String(profile.hardLimitConfidence || '') !== 'measured-upper-bound') return 0;
    const upper = clampAdaptiveLimit(profile.hardLimitUpperBoundTokens);
    const lower = clampAdaptiveLimit(profile.confirmedConversationTokens);
    if (upper <= lower) return 0;
    if (upper < hardLimitSanityFloor(contextLimitTokens)) return 0;
    // If this very conversation has already continued beyond a learned upper bound,
    // that stored upper bound is contradicted by live evidence and must self-heal.
    if (Math.max(0, Number(currentTokens) || 0) > upper) return 0;
    return upper;
  }

  function computeLocalBudget({
    historyTokens = 0,
    draftTokens = 0,
    contextLimitTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
    adaptiveSafeLimitTokens = 0,
    hardLimitUpperBoundTokens = 0,
    confirmedLowerBoundTokens = 0,
  } = {}) {
    const nominalLimit = Math.max(16_000, Number(contextLimitTokens) || DEFAULT_CONTEXT_WINDOW_TOKENS);
    const baseSafeLimitTokens = Math.floor(nominalLimit * SAFETY_BUDGET_RATIO);
    const learnedSafeLimitTokens = clampAdaptiveLimit(adaptiveSafeLimitTokens);
    const confirmedLower = clampAdaptiveLimit(confirmedLowerBoundTokens);
    const learnedHardUpper = clampAdaptiveLimit(hardLimitUpperBoundTokens);
    const hardLimitUsable = learnedHardUpper > confirmedLower;
    const unconstrainedSafeLimitTokens = Math.max(baseSafeLimitTokens, learnedSafeLimitTokens);
    const safeLimitTokens = hardLimitUsable
      ? Math.max(16_000, confirmedLower, Math.min(unconstrainedSafeLimitTokens, learnedHardUpper))
      : unconstrainedSafeLimitTokens;
    const reserveBasis = hardLimitUsable ? safeLimitTokens : Math.max(nominalLimit, safeLimitTokens);
    const reserveTokens = reserveTokensForWindow(reserveBasis);
    const usedTokens = Math.max(0, Math.ceil(Number(historyTokens) || 0) + Math.ceil(Number(draftTokens) || 0));
    const remainingTokens = Math.max(0, safeLimitTokens - usedTokens);
    return {
      nominalLimitTokens: nominalLimit,
      baseSafeLimitTokens,
      safeLimitTokens,
      reserveTokens,
      historyTokens: Math.max(0, Math.ceil(Number(historyTokens) || 0)),
      draftTokens: Math.max(0, Math.ceil(Number(draftTokens) || 0)),
      usedTokens,
      remainingTokens,
      remainingPercent: safeLimitTokens > 0 ? clampPercent((remainingTokens / safeLimitTokens) * 100) : 0,
    };
  }

  function remainingForMetric(currentValue, observedLimit) {
    const current = Math.max(0, Number(currentValue) || 0);
    const limit = Math.max(0, Number(observedLimit) || 0);
    if (limit <= 0) return null;
    return clampPercent((1 - (current / limit)) * 100);
  }

  function diagnosticConversationHash(value) {
    const text = String(value ?? 'unknown');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `ctx-${hash.toString(16).padStart(8, '0')}`;
  }

  function calculateRemainingPercent({ snapshot = null, hardLimitVisible = false, localBudget = null } = {}) {
    // Only a currently visible, independently detected ChatGPT system notice may force 0%.
    // A stale snapshot flag from an older DOM state is deliberately ignored.
    if (hardLimitVisible) {
      return { percent: 0, source: 'chatgpt-visible-hard-limit', metricCount: 0 };
    }
    if (localBudget?.safeLimitTokens > 0) {
      return {
        percent: clampPercent((localBudget.remainingTokens / localBudget.safeLimitTokens) * 100),
        source: localBudget.learnedHardLimitActive
          ? 'learned-chatgpt-thread-boundary'
          : 'local-operational-budget',
        metricCount: 1,
      };
    }
    return { percent: 0, source: 'unknown', metricCount: 0 };
  }

  function buildDiagnosticDetails(snapshot, localBudget, result) {
    return {
      conversationHash: diagnosticConversationHash(snapshot?.conversationKey),
      model: normalizeModelId(snapshot?.model),
      remainingPercent: Number(clampPercent(result?.percent).toFixed(2)),
      remainingDisplay: formatPercent(result?.percent),
      remainingSource: String(result?.source || 'unknown'),
      measurementSource: String(localBudget?.measurementSource || 'unknown'),
      historyTokens: Math.max(0, Math.ceil(Number(localBudget?.historyTokens) || 0)),
      historyCharacters: Math.max(0, Math.ceil(Number(localBudget?.historyCharacters) || 0)),
      historyMessages: Math.max(0, Math.ceil(Number(localBudget?.historyMessages) || 0)),
      cumulativeTokens: Math.max(0, Math.ceil(Number(localBudget?.cumulativeTokens) || 0)),
      cumulativeCharacters: Math.max(0, Math.ceil(Number(localBudget?.cumulativeCharacters) || 0)),
      cumulativeMessages: Math.max(0, Math.ceil(Number(localBudget?.cumulativeMessages) || 0)),
      checkpointMatched: snapshot?.checkpointMatched === true,
      checkpointRestored: snapshot?.checkpointRestored === true,
      hardLimitObservedCount: Math.max(0, Math.floor(Number(snapshot?.hardLimitObservedCount) || 0)),
      hardLimitConfidence: String(localBudget?.hardLimitConfidence || snapshot?.hardLimitConfidence || ''),
      learnedHardLimitActive: localBudget?.learnedHardLimitActive === true,
      learnedHardLimitContradicted: localBudget?.learnedHardLimitContradicted === true,
    };
  }

  const api = Object.freeze({
    clampPercent,
    formatPercent,
    normalizeModelId,
    contextWindowForModel,
    estimateTextTokens,
    estimatePartTokens,
    computeLocalBudget,
    remainingForMetric,
    hardLimitSanityFloor,
    credibleHardLimitUpperBound,
    calculateRemainingPercent,
    diagnosticConversationHash,
    buildDiagnosticDetails,
  });
  globalThis[KEY] = api;

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  let rootObserver = null;
  let observedRoot = null;
  let refreshQueued = false;
  let lastDiagnosticFingerprint = '';
  let lastDiagnosticAt = 0;

  function visible(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function elementText(element) {
    return String(element?.innerText || element?.textContent || '');
  }

  function mediaCounts(root, max = 16) {
    if (!root?.querySelectorAll) return { images: 0, attachments: 0 };
    return {
      images: boundedCount(root.querySelectorAll('img').length, max),
      attachments: boundedCount(root.querySelectorAll('[data-testid*="file" i],[data-testid*="attachment" i],a[download]').length, max),
    };
  }

  function findComposer() {
    return COMPOSER_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find((element) => element && visible(element)) || null;
  }

  function composerText(composer = findComposer()) {
    if (!composer) return '';
    if ('value' in composer && typeof composer.value === 'string') return composer.value;
    return elementText(composer);
  }

  function conversationElements() {
    const composer = findComposer();
    const roleElements = [...document.querySelectorAll('[data-message-author-role]')]
      .filter((element) => !composer || !element.contains(composer));
    if (roleElements.length) {
      const unique = [];
      const seen = new Set();
      for (const element of roleElements) {
        const turn = element.closest('article[data-testid^="conversation-turn-"]');
        const key = turn || element;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(turn || element);
      }
      return unique;
    }
    return [...document.querySelectorAll('article[data-testid^="conversation-turn-"]')]
      .filter((element) => !composer || !element.contains(composer));
  }

  function domHistoryMeasurement() {
    let tokens = 0;
    let characters = 0;
    let messages = 0;
    for (const element of conversationElements()) {
      const text = elementText(element);
      const media = mediaCounts(element);
      if (!text && media.images === 0 && media.attachments === 0) continue;
      tokens += estimatePartTokens({ text, ...media });
      characters += text.length;
      messages += 1;
    }
    return { tokens, characters, messages, source: 'dom-fallback' };
  }

  function fullHistoryMeasurement(budgetApi) {
    const source = budgetApi?.privateHistorySnapshot?.();
    if (!source || !Array.isArray(source.history) || !source.history.length) return null;
    let tokens = 0;
    let characters = 0;
    let messages = 0;
    for (const part of source.history) {
      const text = typeof part?.text === 'string' ? part.text : '';
      const images = boundedCount(part?.images);
      const attachments = boundedCount(part?.attachments);
      if (!text && images === 0 && attachments === 0) continue;
      tokens += estimatePartTokens({ text, images, attachments });
      characters += text.length;
      messages += 1;
    }
    if (!messages) return null;
    return { tokens, characters, messages, source: 'conversation-tree' };
  }

  function currentLocalBudget(snapshot, profile, budgetApi) {
    const measured = fullHistoryMeasurement(budgetApi) || domHistoryMeasurement();
    const composer = findComposer();
    const draft = composerText(composer);
    const composerRoot = composer?.closest('form') || composer?.parentElement || composer;
    const draftMedia = mediaCounts(composerRoot);
    const draftTokens = draft.trim() || draftMedia.images || draftMedia.attachments
      ? estimatePartTokens({ text: draft, ...draftMedia })
      : 0;
    const windowProfile = contextWindowForModel(snapshot?.model);
    const cumulativeTokens = Math.max(measured.tokens, Number(snapshot?.cumulativeConversationTokens) || 0);
    const rawHardUpper = clampAdaptiveLimit(profile?.hardLimitUpperBoundTokens);
    const credibleHardUpper = credibleHardLimitUpperBound({
      profile,
      contextLimitTokens: windowProfile.tokens,
      currentTokens: cumulativeTokens,
    });
    const learnedHardLimitContradicted = rawHardUpper > 0
      && Math.max(0, cumulativeTokens) > rawHardUpper;
    const budget = computeLocalBudget({
      historyTokens: measured.tokens,
      draftTokens,
      contextLimitTokens: windowProfile.tokens,
      adaptiveSafeLimitTokens: profile?.adaptiveSafeLimitTokens,
      hardLimitUpperBoundTokens: credibleHardUpper,
      confirmedLowerBoundTokens: profile?.confirmedConversationTokens,
    });
    return {
      ...budget,
      model: windowProfile.model,
      contextWindowSource: windowProfile.source,
      contextLimitTokens: windowProfile.tokens,
      measurementSource: measured.source,
      historyCharacters: measured.characters,
      historyMessages: measured.messages,
      cumulativeTokens,
      cumulativeCharacters: Math.max(measured.characters, Number(snapshot?.cumulativeConversationCharacters) || 0),
      cumulativeMessages: Math.max(measured.messages, Number(snapshot?.cumulativeMessageCount) || 0),
      learnedHardLimitActive: credibleHardUpper > 0,
      learnedHardLimitUpperBoundTokens: credibleHardUpper,
      learnedHardLimitContradicted,
      hardLimitConfidence: profile?.hardLimitConfidence || null,
    };
  }

  function hasVisibleConversationHardLimit(budgetApi) {
    const classifier = budgetApi?.classifyConversationLengthLimitText;
    if (typeof classifier !== 'function') return false;
    const candidates = [...document.querySelectorAll('p,[role="alert"],[role="status"]')].filter(visible);
    for (const element of candidates) {
      if (element.closest('#gptlock-context-warning-host,#gptlock-context-learning-toast,#gptlock-context-hard-limit-toast')) continue;
      if (!classifier(elementText(element).replace(/\s+/g, ' ').trim())) continue;
      // Quoted/repeated limit text inside a normal conversation turn is content, not ChatGPT chrome.
      if (element.closest('[data-message-author-role],article[data-testid^="conversation-turn-"]')) continue;
      const semanticNotice = ['alert', 'status'].includes(String(element.getAttribute('role') || '').toLowerCase());
      let hasNewChatAction = false;
      let container = element;
      for (let depth = 0; depth < 7 && container; depth += 1, container = container.parentElement) {
        hasNewChatAction = [...(container.querySelectorAll?.('button,a') || [])]
          .some((candidate) => visible(candidate) && HARD_LIMIT_ACTION_PATTERN.test(elementText(candidate)));
        if (hasNewChatAction) break;
      }
      if (semanticNotice || hasNewChatAction) return true;
    }
    return false;
  }

  function maybeLogDiagnostic(details) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    const fingerprint = [
      details.conversationHash,
      details.remainingDisplay,
      details.remainingSource,
      details.measurementSource,
      details.historyTokens,
      details.cumulativeTokens,
      details.checkpointMatched,
      details.learnedHardLimitActive,
      details.learnedHardLimitContradicted,
    ].join(':');
    if (fingerprint === lastDiagnosticFingerprint) return;
    const now = Date.now();
    if (lastDiagnosticAt && now - lastDiagnosticAt < DIAGNOSTIC_MIN_INTERVAL_MS) return;
    lastDiagnosticFingerprint = fingerprint;
    lastDiagnosticAt = now;
    void chrome.runtime.sendMessage({
      type: 'GPTLOCK_CONTEXT_BUDGET_DIAGNOSTIC',
      details,
    }).catch(() => {});
  }

  function detailText(result, localBudget, snapshot) {
    const scope = `\n统计范围：仅当前对话（${diagnosticConversationHash(snapshot?.conversationKey)}）`;
    if (result.source === 'chatgpt-visible-hard-limit') {
      return `聊天长度剩余：0%\n当前页面检测到 ChatGPT 自身、位于聊天消息之外的“对话长度上限”系统提示，因此本聊天此刻记为 0%。${scope}`;
    }
    if (result.source === 'learned-chatgpt-thread-boundary') {
      return `聊天长度剩余：${formatPercent(result.percent)}\n仅使用可信的实测 token 上界参与学习；字符数和消息数不再作为硬上限。若当前聊天成功超过旧上界，旧样本会自动失效。${scope}`;
    }
    if (result.source === 'local-operational-budget') {
      const source = localBudget?.measurementSource === 'conversation-tree' ? '完整活动分支' : '页面消息';
      const selfHeal = localBudget?.learnedHardLimitContradicted
        ? '\n自愈：检测到当前聊天已超过旧的学习上界，已忽略该旧样本。'
        : '';
      return `聊天长度剩余：${formatPercent(result.percent)}\n按${source}和当前模型安全预算持续估算；不会因历史消息条数/字符数样本直接归零。${selfHeal}${scope}`;
    }
    return `聊天长度剩余：未知\n当前页面尚没有足够聊天内容用于估算。${scope}`;
  }

  function observeRoot(root) {
    if (!root || observedRoot === root) return;
    rootObserver?.disconnect();
    observedRoot = root;
    rootObserver = new MutationObserver(scheduleRefresh);
    rootObserver.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  function ensureStyle(root) {
    if (root.getElementById('gptlock-chat-length-remaining-style')) return;
    const style = document.createElement('style');
    style.id = 'gptlock-chat-length-remaining-style';
    style.textContent = `
      [data-source="context"]{grid-template-columns:84px minmax(0,1fr)!important}
      [data-source="context"][data-status="danger"] .model-value{color:#fecaca}
      [data-source="context"][data-status="warning"] .model-value{color:#fde68a}
      [data-source="context"][data-status="safe"] .model-value{color:#dcfce7}
    `;
    root.append(style);
  }

  function render() {
    refreshQueued = false;
    const budgetApi = globalThis.__GPTLOCK_CONTEXT_BUDGET__;
    const snapshot = budgetApi?.snapshot?.() || null;
    if (!snapshot) return;
    const profile = budgetApi?.learningProfile?.() || null;
    const localBudget = currentLocalBudget(snapshot, profile, budgetApi);
    const hardLimitVisible = hasVisibleConversationHardLimit(budgetApi);
    const result = calculateRemainingPercent({ snapshot, hardLimitVisible, localBudget });
    const diagnosticDetails = buildDiagnosticDetails(snapshot, localBudget, result);
    maybeLogDiagnostic(diagnosticDetails);

    const host = document.getElementById('gptlock-model-indicator-host');
    const root = host?.shadowRoot;
    const button = root?.querySelector('button');
    if (!root || !button) return;
    observeRoot(root);
    ensureStyle(root);

    let row = root.querySelector('[data-source="context"]');
    if (!row) {
      row = document.createElement('span');
      row.className = 'model-row';
      row.dataset.source = 'context';
      row.innerHTML = '<span class="model-key"></span><span class="model-value"></span>';
      button.append(row);
    }

    const key = row.querySelector('.model-key');
    const value = row.querySelector('.model-value');
    if (key && key.textContent !== '聊天长度剩余') key.textContent = '聊天长度剩余';
    const text = formatPercent(result.percent);
    if (value && value.textContent !== text) value.textContent = text;

    const status = result.percent <= 0 ? 'danger' : result.percent <= 20 ? 'warning' : 'safe';
    if (row.dataset.status !== status) row.dataset.status = status;
    if (row.dataset.remainingSource !== result.source) row.dataset.remainingSource = result.source;
    if (row.dataset.measurementSource !== localBudget.measurementSource) row.dataset.measurementSource = localBudget.measurementSource;

    const detail = detailText(result, localBudget, snapshot);
    if (row.title !== detail) row.title = detail;
    if (row.getAttribute('aria-label') !== detail) row.setAttribute('aria-label', detail);
  }

  function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(render);
  }

  window.addEventListener('gptlock:context-budget', scheduleRefresh);
  window.addEventListener('gptlock:context-hard-limit-learned', scheduleRefresh);
  window.addEventListener('gptlock:context-limit-learned', scheduleRefresh);
  window.addEventListener('popstate', scheduleRefresh);
  window.addEventListener('hashchange', scheduleRefresh);
  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  window.setInterval(render, REFRESH_MS);
  render();
})();
