(() => {
  const REFRESH_DEBOUNCE_MS = 220;
  const PERIODIC_REFRESH_MS = 30_000;
  const SEND_DEDUPE_MS = 750;
  const BYPASS_WINDOW_MS = 8_000;
  const BYPASS_OBSERVATION_TIMEOUT_MS = 3 * 60 * 1000;
  const RESPONSE_SETTLE_MS = 1_200;
  const ACCOUNT_SCOPE_REFRESH_MS = 5 * 60 * 1000;
  const ACCOUNT_FETCH_TIMEOUT_MS = 4_000;
  const CONVERSATION_FETCH_TIMEOUT_MS = 5_000;
  const CONVERSATION_METRICS_REFRESH_MS = 5_000;
  const CONVERSATION_METRICS_MAX_AGE_MS = 30_000;
  const CONTEXT_PROFILE_STORAGE_PREFIX = 'gptlock.context-profile.v1:';
  const CONTEXT_STATE_STORAGE_PREFIX = 'gptlock.context-state.v1:';
  const PENDING_BYPASS_STORAGE_PREFIX = 'gptlock.context-pending-bypass.v1:';
  const CONTEXT_CHECKPOINT_PERSIST_DEBOUNCE_MS = 800;
  const AUTO_PROBE_PREFIX = 'GPTWork 自动验证';
  const PRIVATE_CONTEXT_PROFILE_MESSAGE_TYPE = 'GPTLOCK_PRIVATE_CONTEXT_PROFILE';
  const COMPOSER_SELECTORS = [
    '#prompt-textarea',
    'textarea[data-testid*="prompt"]',
    '[contenteditable="true"][data-testid*="composer"]',
    '.ProseMirror[contenteditable="true"]',
  ];
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-submit-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="发送提示"]',
    'button[aria-label="发送消息"]',
  ];
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[data-testid="composer-stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="停止生成"]',
    'button[aria-label="停止回答"]',
  ];
  const ACCOUNT_ENDPOINTS = [
    '/api/auth/session',
    '/backend-api/me',
  ];
  const ERROR_TEXT_PATTERNS = [
    /something went wrong/i,
    /there was an error generating/i,
    /network error/i,
    /error generating a response/i,
    /出了点问题/,
    /生成回复时出错/,
    /网络错误/,
  ];
  const CONVERSATION_LENGTH_LIMIT_PATTERNS = [
    { locale: 'zh-CN', pattern: /你已(?:到达|达到)(?:此)?对话的长度上限[，,。.!！\s]*(?:你可以)?(?:开始|开启|新建)(?:一个)?新(?:聊天|对话).*继续(?:此)?对话/ },
    { locale: 'en', pattern: /(?:you(?:'|’)ve|you have) reached (?:the )?(?:maximum|max) (?:length|limit) (?:for|of) (?:this )?conversation[,.!\s]*(?:you can )?.*(?:start|begin) (?:a )?new chat/i },
    { locale: 'en', pattern: /this conversation (?:has )?reached (?:its )?(?:maximum|max) (?:length|limit).*(?:start|begin) (?:a )?new chat/i },
  ];
  const NEW_CHAT_ACTION_PATTERN = /开始新(?:对话|聊天)|新建(?:对话|聊天)|start (?:a )?new chat|new chat/i;

  let lastSnapshot = null;
  let lastKnownModel = null;
  let lastGuardState = null;
  let refreshTimer = null;
  let sendAllowedAt = 0;
  let bypassUntil = 0;
  let warningHost = null;
  let warningSnapshot = null;
  let pendingBypass = null;
  let currentAccountScope = null;
  let currentAccountScopeSource = null;
  let accountScopeCheckedAt = 0;
  let accountScopePromise = null;
  let activeProfile = null;
  let activeProfileKey = null;
  let profileLoadSequence = 0;
  let lastLoadedProfileModel = null;
  let conversationMetricsCache = null;
  let conversationMetricsCheckedAt = 0;
  let conversationMetricsPromise = null;
  let conversationMetricsPromiseKey = null;
  let conversationMetricsRequestSequence = 0;
  let observedConversationKey = null;
  let restoredCheckpoint = null;
  let restoredCheckpointKey = null;
  let checkpointLoadSequence = 0;
  let checkpointPersistTimer = null;
  let restoredPendingKey = null;
  let lastHardLimitNotice = null;
  let hardLimitLearningInFlight = false;
  let lastHardLimitFingerprint = null;
  let privateSendCheckInFlight = false;
  let privateAuthorityReplayUntil = 0;

  function normalizeModelId(value) {
    const model = String(value ?? '').trim().toLowerCase();
    if (!model) return null;
    if (model === 'gpt-5.6-sol-wm' || model === 'gpt-5-6') return 'gpt-5.6-sol';
    return /^[a-z0-9._:-]{1,128}$/.test(model) ? model : null;
  }

  function storedMetric(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(number));
  }

  function conversationMessageText(message) {
    const content = message?.content;
    if (!content || typeof content !== 'object') return '';
    const pieces = [];
    const append = (value) => {
      if (typeof value === 'string' && value) pieces.push(value);
    };
    if (Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (typeof part === 'string') append(part);
        else if (part && typeof part === 'object') {
          append(part.text);
          append(part.content);
          append(part.result);
          append(part.output);
        }
      }
    }
    append(content.text);
    append(content.result);
    append(content.output);
    return pieces.join('\n');
  }

  function conversationMessageMediaCounts(message) {
    const content = message?.content;
    let images = 0;
    let attachments = 0;
    if (content && typeof content === 'object' && Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (!part || typeof part !== 'object') continue;
        const kind = String(part.content_type || part.type || '').toLowerCase();
        if (part.asset_pointer || kind.includes('image')) images += 1;
        else if (kind.includes('file') || kind.includes('attachment')) attachments += 1;
      }
    }
    const metadataAttachments = message?.metadata?.attachments;
    if (Array.isArray(metadataAttachments)) attachments += metadataAttachments.length;
    return {
      images: Math.min(32, images),
      attachments: Math.min(32, attachments),
    };
  }

  function activeConversationMessages(payload) {
    const mapping = payload?.mapping;
    let cursor = String(payload?.current_node || '').trim();
    if (!mapping || typeof mapping !== 'object' || !cursor) return [];
    const reversed = [];
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = mapping[cursor];
      if (!node || typeof node !== 'object') break;
      if (node.message && typeof node.message === 'object') reversed.push(node.message);
      cursor = String(node.parent || '').trim();
    }
    return reversed.reverse();
  }

  function extractConversationMetrics(payload) {
    const messages = activeConversationMessages(payload);
    if (!messages.length) return null;
    let characters = 0;
    let countedMessages = 0;
    const privateHistoryParts = [];
    for (const message of messages) {
      const text = conversationMessageText(message);
      const media = conversationMessageMediaCounts(message);
      if (!text && media.images === 0 && media.attachments === 0) continue;
      privateHistoryParts.push({ text, images: media.images, attachments: media.attachments });
      characters += text.length;
      countedMessages += 1;
    }
    if (!countedMessages) return null;
    return {
      characters: Math.max(0, Math.ceil(characters)),
      messageCount: countedMessages,
      currentNode: payload?.current_node ? String(payload.current_node).slice(0, 256) : null,
      privateHistoryParts,
    };
  }

  function profileStorageKey(accountScope, model) {
    const account = String(accountScope ?? '').trim();
    const normalizedModel = normalizeModelId(model);
    if (!account || !normalizedModel) return null;
    return `${CONTEXT_PROFILE_STORAGE_PREFIX}${account}:${normalizedModel}`;
  }

  function checkpointStorageKey(accountScope, conversationId, model) {
    const account = String(accountScope ?? '').trim();
    const conversation = String(conversationId ?? '').trim();
    const normalizedModel = normalizeModelId(model);
    if (!account || !conversation || !normalizedModel) return null;
    return `${CONTEXT_STATE_STORAGE_PREFIX}${account}:${conversation}:${normalizedModel}`;
  }

  function pendingBypassStorageKey(accountScope, conversationId, model) {
    const account = String(accountScope ?? '').trim();
    const conversation = String(conversationId ?? '').trim();
    const normalizedModel = normalizeModelId(model);
    if (!account || !conversation || !normalizedModel) return null;
    return `${PENDING_BYPASS_STORAGE_PREFIX}${account}:${conversation}:${normalizedModel}`;
  }

  function checkpointMatchesContext(checkpoint, {
    accountScope,
    conversationId,
    conversationKey,
    model,
  } = {}) {
    if (!checkpoint || typeof checkpoint !== 'object') return false;
    const account = String(accountScope ?? '').trim();
    const conversation = String(conversationId ?? '').trim();
    const key = String(conversationKey ?? '').trim();
    const normalizedModel = normalizeModelId(model);
    if (!account || !conversation || !key || !normalizedModel) return false;
    return checkpoint.accountScope === account
      && checkpoint.conversationId === conversation
      && checkpoint.conversationKey === key
      && normalizeModelId(checkpoint.model) === normalizedModel;
  }

  function buildContextCheckpoint({
    previous = null,
    accountScope,
    accountScopeSource = 'unknown',
    conversationId,
    conversationKey,
    model,
    snapshot,
    currentNode = null,
    measuredAt = new Date().toISOString(),
  } = {}) {
    const normalizedModel = normalizeModelId(model);
    const account = String(accountScope ?? '').trim();
    const conversation = String(conversationId ?? '').trim();
    if (!account || !conversation || !normalizedModel || !snapshot) return null;
    const activeTokens = Math.max(0, Math.ceil(Number(snapshot.historyTokens) || 0));
    const activeCharacters = Math.max(0, Math.ceil(Number(snapshot.historyCharacters) || 0));
    const activeMessages = Math.max(0, Math.ceil(Number(snapshot.messageCount) || 0));
    const previousActiveTokens = Math.max(0, Math.ceil(Number(previous?.activeContextTokens) || 0));
    const previousActiveCharacters = Math.max(0, Math.ceil(Number(previous?.activeContextCharacters) || 0));
    const previousActiveMessages = Math.max(0, Math.ceil(Number(previous?.activeMessageCount) || 0));
    const cumulativeTokens = Math.max(
      activeTokens,
      Math.max(0, Math.ceil(Number(previous?.cumulativeTokens) || 0)) + Math.max(0, activeTokens - previousActiveTokens),
    );
    const cumulativeCharacters = Math.max(
      activeCharacters,
      Math.max(0, Math.ceil(Number(previous?.cumulativeCharacters) || 0)) + Math.max(0, activeCharacters - previousActiveCharacters),
    );
    const cumulativeMessages = Math.max(
      activeMessages,
      Math.max(0, Math.ceil(Number(previous?.cumulativeMessages) || 0)) + Math.max(0, activeMessages - previousActiveMessages),
    );
    return {
      schemaVersion: 1,
      accountScope: account,
      accountScopeSource,
      conversationId: conversation,
      conversationKey: String(conversationKey || `conversation:${conversation}`).slice(0, 256),
      model: normalizedModel,
      activeContextTokens: activeTokens,
      activeContextCharacters: activeCharacters,
      activeMessageCount: activeMessages,
      cumulativeTokens,
      cumulativeCharacters,
      cumulativeMessages,
      lastCurrentNode: currentNode ? String(currentNode).slice(0, 256) : null,
      measurementSource: String(snapshot.historyMeasurementSource || 'unknown').slice(0, 80),
      lastMeasuredAt: measuredAt,
      lastLiveSyncedAt: measuredAt,
    };
  }

  function serializePendingBypassRecord(pending) {
    if (!pending?.accountScope || !pending?.model || !pending?.conversationKey) return null;
    const startedAt = Math.max(0, Number(pending.startedAt) || 0);
    if (!startedAt) return null;
    return {
      schemaVersion: 1,
      startedAt,
      expiresAt: startedAt + BYPASS_OBSERVATION_TIMEOUT_MS,
      conversationKey: String(pending.conversationKey).slice(0, 256),
      model: normalizeModelId(pending.model),
      accountScope: String(pending.accountScope),
      accountScopeSource: String(pending.accountScopeSource || 'unknown').slice(0, 80),
      baselineAssistantCount: Math.max(0, Math.floor(Number(pending.baselineAssistantCount) || 0)),
      requestId: pending.requestId ? String(pending.requestId).slice(0, 256) : null,
      requestObserved: Boolean(pending.requestObserved),
      responseSeen: Boolean(pending.responseSeen),
      responseSuccessful: pending.responseSuccessful === true ? true : pending.responseSuccessful === false ? false : null,
      preSnapshot: pending.preSnapshot ? {
        usedTokens: Math.max(0, Math.ceil(Number(pending.preSnapshot.usedTokens) || 0)),
        fullConversationCharacters: Math.max(0, Math.ceil(Number(pending.preSnapshot.fullConversationCharacters) || 0)),
        conversationKey: String(pending.preSnapshot.conversationKey || pending.conversationKey).slice(0, 256),
        model: normalizeModelId(pending.preSnapshot.model || pending.model),
      } : null,
    };
  }

  function restorePendingBypassRecord(record, {
    now = Date.now(),
    accountScope,
    conversationKey,
    model,
  } = {}) {
    if (!record || Number(record.schemaVersion) !== 1) return null;
    if (Number(record.expiresAt) <= Number(now)) return null;
    if (String(record.accountScope || '') !== String(accountScope || '')) return null;
    if (String(record.conversationKey || '') !== String(conversationKey || '')) return null;
    if (normalizeModelId(record.model) !== normalizeModelId(model)) return null;
    if (!record.requestObserved || !record.preSnapshot?.usedTokens) return null;
    return {
      ...record,
      learningStarted: false,
      stableSignature: null,
      stableSince: 0,
    };
  }

  function classifyConversationLengthLimitText(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_000);
    if (!text) return null;
    for (const entry of CONVERSATION_LENGTH_LIMIT_PATTERNS) {
      if (entry.pattern.test(text)) return { matched: true, locale: entry.locale, text };
    }
    return null;
  }

  function privateHistorySnapshot() {
    const conversationKey = currentConversationKey();
    const cacheFresh = Boolean(
      conversationMetricsCache
      && conversationMetricsCache.conversationKey === conversationKey
      && Date.now() - conversationMetricsCheckedAt <= CONVERSATION_METRICS_MAX_AGE_MS
      && Array.isArray(conversationMetricsCache.privateHistoryParts)
      && conversationMetricsCache.privateHistoryParts.length > 0
    );
    if (!cacheFresh) return null;
    return {
      conversationKey,
      model: detectModel(),
      measuredAt: conversationMetricsCache.measuredAt || null,
      history: conversationMetricsCache.privateHistoryParts.map((part) => ({
        text: typeof part?.text === 'string' ? part.text : '',
        images: Math.max(0, Number(part?.images) || 0),
        attachments: Math.max(0, Number(part?.attachments) || 0),
      })),
    };
  }

  const api = {
    profileStorageKey,
    classifyConversationLengthLimitText,
    extractConversationMetrics,
    checkpointStorageKey,
    checkpointMatchesContext,
    pendingBypassStorageKey,
    buildContextCheckpoint,
    serializePendingBypassRecord,
    restorePendingBypassRecord,
    privateHistorySnapshot,
    refreshPrivateHistory: async () => {
      await refreshConversationMetrics(true);
      return privateHistorySnapshot();
    },
    snapshot: () => lastSnapshot,
    learningProfile: () => activeProfile,
    checkpoint: () => restoredCheckpoint,
  };
  globalThis.__GPTLOCK_CONTEXT_BUDGET__ = api;

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  function visible(element) {
    const rect = element?.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden');
  }

  function findVisibleConversationLengthLimit() {
    const candidates = [...document.querySelectorAll('p,[role="alert"],[role="status"]')].filter(visible);
    for (const element of candidates) {
      if (element.closest('#gptlock-context-warning-host,#gptlock-context-learning-toast,#gptlock-context-hard-limit-toast')) continue;
      const match = classifyConversationLengthLimitText(elementText(element));
      if (!match) continue;
      let actionText = '';
      let container = element;
      for (let depth = 0; depth < 7 && container; depth += 1, container = container.parentElement) {
        const action = [...(container.querySelectorAll?.('button,a') || [])]
          .find((candidate) => visible(candidate) && NEW_CHAT_ACTION_PATTERN.test(elementText(candidate).trim()));
        if (action) { actionText = elementText(action).trim(); break; }
      }
      const insideConversationTurn = Boolean(element.closest('[data-message-author-role],article[data-testid^="conversation-turn-"]'));
      const semanticNotice = ['alert', 'status'].includes(String(element.getAttribute('role') || '').toLowerCase());
      if (!actionText && insideConversationTurn && !semanticNotice) continue;
      return { ...match, actionText: actionText.slice(0, 120) };
    }
    return null;
  }

  function findComposer() {
    return COMPOSER_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find((element) => element && visible(element)) || null;
  }

  function composerText(composer = findComposer()) {
    if (!composer) return '';
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) return composer.value || '';
    return composer.innerText || composer.textContent || '';
  }

  function attachmentCount(root) {
    if (!root?.querySelectorAll) return 0;
    const fileLike = root.querySelectorAll('[data-testid*="file" i],[data-testid*="attachment" i],a[download]');
    return Math.min(16, fileLike.length);
  }

  function imageCount(root) {
    if (!root?.querySelectorAll) return 0;
    return Math.min(16, root.querySelectorAll('img').length);
  }

  function elementText(element) {
    return element?.innerText || element?.textContent || '';
  }

  function elementMetrics(element) {
    return { characters: elementText(element).length };
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

  function assistantElements() {
    const unique = [];
    const seen = new Set();
    for (const element of document.querySelectorAll('[data-message-author-role="assistant"]')) {
      const turn = element.closest('article[data-testid^="conversation-turn-"]') || element;
      if (seen.has(turn)) continue;
      seen.add(turn);
      unique.push(turn);
    }
    return unique;
  }

  function assistantStats() {
    const elements = assistantElements();
    const last = elements[elements.length - 1] || null;
    const lastMetrics = last ? elementMetrics(last) : { characters: 0 };
    return {
      count: elements.length,
      lastCharacters: lastMetrics.characters,
    };
  }

  function detectModel() {
    const validated = globalThis.__GPTLOCK_PAGE_MODEL_EVIDENCE__?.collect?.();
    const pageModel = normalizeModelId(validated?.model);
    return normalizeModelId(lastKnownModel) || pageModel || null;
  }

  function currentConversationId() {
    try {
      return new URL(location.href).pathname.match(/(?:^|\/)c\/([a-zA-Z0-9_-]+)/)?.[1] || null;
    } catch {
      return null;
    }
  }

  function currentConversationKey() {
    try {
      const url = new URL(location.href);
      const conversationId = currentConversationId();
      return conversationId ? `conversation:${conversationId}` : `page:${url.pathname}`;
    } catch {
      return 'unknown';
    }
  }

  async function loadConversationCheckpoint() {
    const sequence = ++checkpointLoadSequence;
    const conversationId = currentConversationId();
    const model = detectModel();
    const key = checkpointStorageKey(currentAccountScope, conversationId, model);
    restoredCheckpointKey = key;
    if (!key) {
      restoredCheckpoint = null;
      scheduleRefresh();
      return null;
    }
    try {
      const stored = await chrome.storage.local.get(key);
      if (sequence !== checkpointLoadSequence) return null;
      const checkpoint = stored[key] ?? null;
      if (checkpointMatchesContext(checkpoint, {
        accountScope: currentAccountScope,
        conversationId,
        conversationKey: currentConversationKey(),
        model,
      })) {
        restoredCheckpoint = checkpoint;
      } else {
        restoredCheckpoint = null;
      }
    } catch {
      if (sequence !== checkpointLoadSequence) return null;
      restoredCheckpoint = null;
    }
    scheduleRefresh();
    return restoredCheckpoint;
  }

  async function persistConversationCheckpoint(snapshot) {
    const conversationId = currentConversationId();
    const model = normalizeModelId(snapshot?.model) || detectModel();
    const key = checkpointStorageKey(currentAccountScope, conversationId, model);
    if (!key || snapshot?.historyMeasurementSource !== 'conversation-tree+dom-reconcile') return null;
    if (snapshot.conversationKey !== currentConversationKey()) return null;
    try {
      const inMemoryCheckpointUsable = restoredCheckpointKey === key
        && checkpointMatchesContext(restoredCheckpoint, {
          accountScope: currentAccountScope,
          conversationId,
          conversationKey: snapshot.conversationKey,
          model,
        });
      const stored = inMemoryCheckpointUsable
        ? { [key]: restoredCheckpoint }
        : await chrome.storage.local.get(key);
      const previous = stored[key] ?? null;
      const next = buildContextCheckpoint({
        previous,
        accountScope: currentAccountScope,
        accountScopeSource: currentAccountScopeSource || 'unknown',
        conversationId,
        conversationKey: snapshot.conversationKey,
        model,
        snapshot,
        currentNode: conversationMetricsCache?.currentNode || null,
        measuredAt: new Date().toISOString(),
      });
      if (!next) return null;
      await chrome.storage.local.set({ [key]: next });
      restoredCheckpoint = next;
      restoredCheckpointKey = key;
      return next;
    } catch {
      return null;
    }
  }

  function queueConversationCheckpointPersist(snapshot) {
    if (checkpointPersistTimer !== null) window.clearTimeout(checkpointPersistTimer);
    checkpointPersistTimer = window.setTimeout(() => {
      checkpointPersistTimer = null;
      void persistConversationCheckpoint(snapshot);
    }, CONTEXT_CHECKPOINT_PERSIST_DEBOUNCE_MS);
  }

  async function persistPendingBypassState() {
    if (!pendingBypass) return null;
    const conversationId = currentConversationId();
    const model = normalizeModelId(pendingBypass.model) || detectModel();
    const key = pendingBypassStorageKey(pendingBypass.accountScope || currentAccountScope, conversationId, model);
    const record = serializePendingBypassRecord(pendingBypass);
    if (!key || !record) return null;
    try {
      await chrome.storage.local.set({ [key]: record });
      restoredPendingKey = key;
      return record;
    } catch {
      return null;
    }
  }

  async function discardPendingBypass(removeStorage = true) {
    const old = pendingBypass;
    pendingBypass = null;
    const conversationId = currentConversationId();
    const model = normalizeModelId(old?.model) || detectModel();
    const key = restoredPendingKey || pendingBypassStorageKey(old?.accountScope || currentAccountScope, conversationId, model);
    restoredPendingKey = null;
    if (removeStorage && key) {
      try { await chrome.storage.local.remove(key); } catch { /* best effort */ }
    }
  }

  async function restorePendingBypass() {
    if (pendingBypass) return pendingBypass;
    const conversationId = currentConversationId();
    const conversationKey = currentConversationKey();
    const model = detectModel();
    const key = pendingBypassStorageKey(currentAccountScope, conversationId, model);
    if (!key) return null;
    try {
      const stored = await chrome.storage.local.get(key);
      const restored = restorePendingBypassRecord(stored[key], {
        now: Date.now(),
        accountScope: currentAccountScope,
        conversationKey,
        model,
      });
      if (!restored) {
        if (stored[key]) await chrome.storage.local.remove(key);
        return null;
      }
      pendingBypass = restored;
      restoredPendingKey = key;
      scheduleRefresh();
      void maybeFinalizeBypassLearning();
      return pendingBypass;
    } catch {
      return null;
    }
  }

  async function fetchConversationMetrics(conversationId) {
    if (!conversationId) return null;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), CONVERSATION_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = await response.json();
      return extractConversationMetrics(payload);
    } catch {
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function refreshConversationMetrics(force = false) {
    const conversationId = currentConversationId();
    const conversationKey = currentConversationKey();
    if (!conversationId) {
      conversationMetricsRequestSequence += 1;
      conversationMetricsPromise = null;
      conversationMetricsPromiseKey = null;
      conversationMetricsCache = null;
      conversationMetricsCheckedAt = Date.now();
      return null;
    }
    const now = Date.now();
    if (
      !force
      && conversationMetricsCache?.conversationKey === conversationKey
      && now - conversationMetricsCheckedAt < CONVERSATION_METRICS_REFRESH_MS
    ) return conversationMetricsCache;
    if (conversationMetricsPromise && conversationMetricsPromiseKey === conversationKey) {
      return conversationMetricsPromise;
    }

    const requestSequence = ++conversationMetricsRequestSequence;
    const requestPromise = (async () => {
      const metrics = await fetchConversationMetrics(conversationId);
      if (requestSequence !== conversationMetricsRequestSequence || currentConversationKey() !== conversationKey) {
        return null;
      }
      conversationMetricsCheckedAt = Date.now();
      if (metrics) {
        conversationMetricsCache = { ...metrics, conversationKey, measuredAt: new Date().toISOString() };
        scheduleRefresh();
      }
      return conversationMetricsCache;
    })();
    conversationMetricsPromise = requestPromise;
    conversationMetricsPromiseKey = conversationKey;
    try {
      return await requestPromise;
    } finally {
      if (conversationMetricsPromise === requestPromise) {
        conversationMetricsPromise = null;
        conversationMetricsPromiseKey = null;
      }
    }
  }

  function formatCompactTokens(tokens) {
    const value = Math.max(0, Number(tokens) || 0);
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2)}M`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
    return String(Math.round(value));
  }

  function formatCompactNumber(value) {
    const number = Math.max(0, Number(value) || 0);
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 2)}M`;
    if (number >= 1_000) return `${Math.round(number / 1_000)}k`;
    return String(Math.round(number));
  }

  function snapshotNow() {
    const messages = conversationElements();
    const domHistoryCharacters = messages.reduce(
      (total, element) => total + elementMetrics(element).characters,
      0,
    );
    const conversationKey = currentConversationKey();
    const conversationId = currentConversationId();
    const model = detectModel();
    const cacheFresh = Boolean(
      conversationMetricsCache
      && conversationMetricsCache.conversationKey === conversationKey
      && Date.now() - conversationMetricsCheckedAt <= CONVERSATION_METRICS_MAX_AGE_MS
    );
    const checkpointMatched = checkpointMatchesContext(restoredCheckpoint, {
      accountScope: currentAccountScope,
      conversationId,
      conversationKey,
      model,
    });
    const checkpointUsable = Boolean(!cacheFresh && checkpointMatched);
    const historyCharacters = cacheFresh
      ? Math.max(domHistoryCharacters, Number(conversationMetricsCache.characters) || 0)
      : checkpointUsable
        ? Math.max(domHistoryCharacters, Number(restoredCheckpoint.activeContextCharacters) || 0)
        : domHistoryCharacters;
    const historyMessageCount = cacheFresh
      ? Math.max(messages.length, Number(conversationMetricsCache.messageCount) || 0)
      : checkpointUsable
        ? Math.max(messages.length, Number(restoredCheckpoint.activeMessageCount) || 0)
        : messages.length;
    const draft = composerText();
    const confirmedLowerBoundTokens = storedMetric(activeProfile?.confirmedConversationTokens);
    const hardLimitUpperBoundTokens = storedMetric(activeProfile?.hardLimitUpperBoundTokens);
    return {
      nominalLimitTokens: 0,
      baseSafeLimitTokens: 0,
      adaptiveSafeLimitTokens: storedMetric(activeProfile?.adaptiveSafeLimitTokens),
      hardLimitUpperBoundTokens,
      confirmedLowerBoundTokens,
      safeLimitTokens: 0,
      reserveTokens: 0,
      historyTokens: 0,
      draftTokens: 0,
      usedTokens: 0,
      projectedTokens: 0,
      percent: 0,
      projectedPercent: 0,
      remainingTokens: 0,
      warning: false,
      wouldExceed: false,
      adaptiveActive: false,
      hardLimitActive: false,
      model,
      contextWindowSource: 'private-engine-required',
      messageCount: historyMessageCount,
      historyCharacters,
      historyMeasurementSource: cacheFresh
        ? 'conversation-tree+dom-reconcile'
        : checkpointUsable
          ? 'checkpoint+dom-restore'
          : 'dom-fallback',
      checkpointRestored: checkpointUsable,
      checkpointMatched,
      checkpointMeasuredAt: checkpointMatched ? restoredCheckpoint.lastMeasuredAt ?? null : null,
      cumulativeConversationTokens: checkpointMatched ? storedMetric(restoredCheckpoint.cumulativeTokens) : 0,
      cumulativeConversationCharacters: checkpointMatched
        ? Math.max(historyCharacters, Number(restoredCheckpoint.cumulativeCharacters) || 0)
        : historyCharacters,
      cumulativeMessageCount: checkpointMatched
        ? Math.max(historyMessageCount, Number(restoredCheckpoint.cumulativeMessages) || 0)
        : historyMessageCount,
      draftCharacters: draft.length,
      fullConversationCharacters: historyCharacters + draft.length,
      fullConversationTokens: 0,
      conversationKey,
      learnedConfirmedTokens: confirmedLowerBoundTokens,
      learnedSuccessCount: Math.max(0, Number(activeProfile?.successfulBypassCount) || 0),
      learnedAt: activeProfile?.lastConfirmedAt ?? null,
      hardLimitVisible: Boolean(lastHardLimitNotice && lastHardLimitNotice.conversationKey === conversationKey),
      hardLimitObservedTokens: storedMetric(activeProfile?.hardLimitObservedTokens),
      hardLimitObservedCount: Math.max(0, Number(activeProfile?.hardLimitObservedCount) || 0),
      hardLimitConfidence: activeProfile?.hardLimitConfidence ?? (lastHardLimitNotice ? 'ui-boundary-only' : null),
      hardLimitMeasurementSource: activeProfile?.hardLimitMeasurementSource ?? null,
      hardLimitLastObservedAt: activeProfile?.hardLimitLastObservedAt ?? null,
      accountScopeAvailable: Boolean(currentAccountScope),
      accountScopeSource: currentAccountScopeSource,
      budgetAuthority: 'pending-private-engine',
      budgetAvailable: false,
      measuredAt: new Date().toISOString(),
      estimateOnly: true,
    };
  }

  function indicatorDetail(snapshot) {
    const historySource = snapshot.historyMeasurementSource === 'conversation-tree+dom-reconcile'
      ? '完整活动分支'
      : snapshot.historyMeasurementSource === 'checkpoint+dom-restore'
        ? '本地检查点恢复'
        : 'DOM 回退';
    if (snapshot.budgetAuthority !== 'private-engine') {
      const rows = [
        '上下文额度：等待本地私有核心评估',
        `当前活动聊天：${formatCompactNumber(snapshot.fullConversationCharacters)} 字符 · ${snapshot.messageCount} 条消息 · ${historySource}`,
        `模型：${snapshot.model || '未识别'}`,
        '安全策略：浏览器扩展不再执行模型窗口、token/media 权重或发送预算公式；私有核心不可用时正常聊天 fail-open，不生成伪 token 额度。',
      ];
      if (snapshot.learnedConfirmedTokens > 0) {
        rows.push(`历史私有学习：已保存成功下限 ${formatCompactTokens(snapshot.learnedConfirmedTokens)} tokens（${snapshot.learnedSuccessCount} 次）`);
      }
      if (snapshot.hardLimitVisible) rows.push('ChatGPT 已显示真实“对话长度上限”提示；等待私有核心决定是否形成数值上界。');
      return rows.join('\n');
    }

    const rows = [
      `上下文额度：${snapshot.percent.toFixed(1)}%（本地私有核心）`,
      `当前完整聊天：约 ${formatCompactTokens(snapshot.fullConversationTokens)} tokens · ${formatCompactNumber(snapshot.fullConversationCharacters)} 字符 · ${snapshot.messageCount} 条消息 · ${historySource}`,
      `基础安全预算：${formatCompactTokens(snapshot.baseSafeLimitTokens)} / 模型窗口 ${formatCompactTokens(snapshot.nominalLimitTokens)}`,
    ];
    if (snapshot.checkpointRestored) {
      rows.push(`恢复状态：已从上次本地检查点恢复（${snapshot.checkpointMeasuredAt || '时间未知'}），正在与 ChatGPT 当前活动会话重新对账。`);
    }
    if (snapshot.cumulativeConversationTokens > snapshot.fullConversationTokens || snapshot.cumulativeMessageCount > snapshot.messageCount) {
      rows.push(`会话累计观测：约 ${formatCompactTokens(snapshot.cumulativeConversationTokens)} tokens · ${formatCompactNumber(snapshot.cumulativeConversationCharacters)} 字符 · ${snapshot.cumulativeMessageCount} 条消息`);
    }
    if (snapshot.hardLimitVisible || snapshot.hardLimitObservedCount > 0) {
      if (snapshot.hardLimitUpperBoundTokens > snapshot.confirmedLowerBoundTokens) {
        const lower = snapshot.confirmedLowerBoundTokens > 0 ? `；已确认成功下限 ≥ ${formatCompactTokens(snapshot.confirmedLowerBoundTokens)}` : '';
        rows.push(`ChatGPT 实测会话硬上限：≤ ${formatCompactTokens(snapshot.hardLimitUpperBoundTokens)} tokens${lower}`);
      } else {
        rows.push('ChatGPT 已检测到真实“对话长度上限”提示；当前没有可用的可信数值上界。');
      }
    }
    if (snapshot.adaptiveActive) {
      rows.push(
        `账户实测成功下限：至少 ${formatCompactTokens(snapshot.learnedConfirmedTokens)} tokens（${snapshot.learnedSuccessCount} 次超限成功）`,
        `当前自适应发送预算：${formatCompactTokens(snapshot.safeLimitTokens)} tokens`,
      );
    } else {
      rows.push(`当前发送预算：${formatCompactTokens(snapshot.safeLimitTokens)} tokens`);
    }
    rows.push(
      `预留回复：${formatCompactTokens(snapshot.reserveTokens)}`,
      `剩余发送预算：约 ${formatCompactTokens(snapshot.remainingTokens)}`,
      `模型：${snapshot.model || '未识别'} · 本地私有核心`,
      snapshot.accountScopeAvailable
        ? '账户学习：已建立本地匿名账户范围；数值学习由本地私有核心完成。'
        : '账户学习：尚未识别当前 ChatGPT 账户；识别成功前不会跨账户学习。',
      '说明：浏览器只采集当前活动 conversation tree、DOM 与媒体计数；模型窗口、token 估算、预算和学习数值均由本地编译私有核心计算。',
    );
    return rows.join('\n');
  }

  function mountIndicatorRow(snapshot) {
    const host = document.getElementById('gptlock-model-indicator-host');
    const root = host?.shadowRoot;
    const button = root?.querySelector('button');
    if (!button) return;

    if (!root.getElementById('gptlock-context-budget-style')) {
      const style = document.createElement('style');
      style.id = 'gptlock-context-budget-style';
      style.textContent = `
        .model-row[data-source="context"][data-status="safe"] .model-value{color:#dbeafe}
        .model-row[data-source="context"][data-status="warning"] .model-value{color:#fde68a}
        .model-row[data-source="context"][data-status="danger"] .model-value{color:#fecaca;font-weight:850}`;
      root.append(style);
    }

    let row = root.querySelector('[data-source="context"]');
    if (!row) {
      row = document.createElement('span');
      row.className = 'model-row';
      row.dataset.source = 'context';
      row.innerHTML = '<span class="model-key">上下文</span><span class="model-value">估算中</span>';
      button.append(row);
    }
    const hasPrivateBudget = snapshot.budgetAuthority === 'private-engine';
    row.dataset.status = hasPrivateBudget && snapshot.wouldExceed ? 'danger' : hasPrivateBudget && snapshot.warning ? 'warning' : 'safe';
    const value = row.querySelector('.model-value');
    if (value) {
      if (hasPrivateBudget) {
        const adaptiveMark = snapshot.adaptiveActive ? '↗' : '';
        value.textContent = `${snapshot.percent.toFixed(snapshot.percent < 10 ? 1 : 0)}%${adaptiveMark} · 约${formatCompactTokens(snapshot.remainingTokens)}余`;
      } else {
        value.textContent = '等待私有核心';
      }
    }
    row.title = indicatorDetail(snapshot);
    row.setAttribute('aria-label', indicatorDetail(snapshot));
  }

  function publishSnapshot(next) {
    const authority = globalThis.__GPTLOCK_PRIVATE_CONTEXT_BUDGET_AUTHORITY__;
    if (authority?.applyToSnapshot) {
      try { next = authority.applyToSnapshot(next) || next; } catch { /* compatibility fallback */ }
    }
    const previousFingerprint = lastSnapshot
      ? `${Math.round(lastSnapshot.percent * 10)}:${lastSnapshot.model}:${lastSnapshot.messageCount}:${lastSnapshot.wouldExceed}:${lastSnapshot.safeLimitTokens}:${lastSnapshot.budgetAuthority}`
      : '';
    lastSnapshot = next;
    mountIndicatorRow(next);
    if (next.historyMeasurementSource === 'conversation-tree+dom-reconcile' && next.budgetAuthority === 'private-engine') {
      queueConversationCheckpointPersist(next);
    }
    const fingerprint = `${Math.round(next.percent * 10)}:${next.model}:${next.messageCount}:${next.wouldExceed}:${next.safeLimitTokens}:${next.budgetAuthority}`;
    if (fingerprint !== previousFingerprint) {
      window.dispatchEvent(new CustomEvent('gptlock:context-budget', { detail: next }));
    }
  }

  function recompute() {
    refreshTimer = null;
    try {
      ensureConversationNavigation();
      const notice = findVisibleConversationLengthLimit();
      if (notice) lastHardLimitNotice = { ...notice, conversationKey: currentConversationKey(), detectedAt: new Date().toISOString() };
      publishSnapshot(snapshotNow());
      if (notice) void persistHardLimitObservation(lastSnapshot, lastHardLimitNotice);
      void refreshConversationMetrics();
      void maybeFinalizeBypassLearning();
    } catch {
      // ChatGPT DOM can be replaced during navigation; the periodic refresh self-heals.
    }
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = window.setTimeout(recompute, REFRESH_DEBOUNCE_MS);
  }

  api.refresh = () => {
    recompute();
    return lastSnapshot;
  };

  function matchesAny(element, selectors) {
    return selectors.some((selector) => element?.closest?.(selector));
  }

  function isPotentialSend(event) {
    if (event.type === 'click') return matchesAny(event.target, SEND_SELECTORS);
    if (event.type === 'keydown') {
      return event.key === 'Enter'
        && !event.shiftKey
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.isComposing
        && matchesAny(event.target, COMPOSER_SELECTORS);
    }
    if (event.type === 'submit') return Boolean(event.target?.querySelector?.(COMPOSER_SELECTORS.join(',')));
    return false;
  }

  function closeWarning() {
    warningHost?.remove();
    warningHost = null;
    warningSnapshot = null;
  }

  function findSendButton() {
    return SEND_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find((element) => element && visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true') || null;
  }

  function isGenerating() {
    return STOP_SELECTORS.some((selector) => {
      const element = document.querySelector(selector);
      return element && visible(element);
    });
  }

  function hasVisibleGenerationError() {
    if (findVisibleConversationLengthLimit()) return true;
    const candidates = [
      ...document.querySelectorAll('[role="alert"],[data-testid*="error" i],[class*="error" i]'),
    ].filter(visible);
    return candidates.some((element) => {
      const text = elementText(element).trim();
      return text && ERROR_TEXT_PATTERNS.some((pattern) => pattern.test(text));
    });
  }

  function beginBypassObservation(snapshot) {
    const assistant = assistantStats();
    pendingBypass = {
      startedAt: Date.now(),
      conversationKey: snapshot?.conversationKey || currentConversationKey(),
      preSnapshot: snapshot ? { ...snapshot } : snapshotNow(),
      baselineAssistantCount: assistant.count,
      model: normalizeModelId(snapshot?.model) || detectModel(),
      accountScope: currentAccountScope,
      accountScopeSource: currentAccountScopeSource,
      requestId: null,
      requestObserved: false,
      responseSeen: false,
      responseSuccessful: null,
      stableSignature: null,
      stableSince: 0,
      learningStarted: false,
    };
    const observation = pendingBypass;
    if (observation.accountScope) void persistPendingBypassState();
    void refreshAccountScope(true).then(() => {
      if (pendingBypass !== observation) return;
      observation.accountScope = currentAccountScope;
      observation.accountScopeSource = currentAccountScopeSource;
      void persistPendingBypassState();
      void maybeFinalizeBypassLearning();
    });
  }

  function sendAfterExplicitBypass() {
    const snapshot = warningSnapshot || lastSnapshot || snapshotNow();
    if (snapshot?.wouldExceed) beginBypassObservation(snapshot);
    bypassUntil = Date.now() + BYPASS_WINDOW_MS;
    closeWarning();
    const button = findSendButton();
    if (button) {
      button.click();
      return;
    }
    const composer = findComposer();
    const form = composer?.closest('form');
    if (form?.requestSubmit) form.requestSubmit();
  }

  function replayPotentialSend() {
    privateAuthorityReplayUntil = Date.now() + 1_500;
    const button = findSendButton();
    if (button) {
      button.click();
      return;
    }
    const composer = findComposer();
    const form = composer?.closest('form');
    if (form?.requestSubmit) form.requestSubmit();
  }

  function showContextWarning(snapshot) {
    closeWarning();
    warningSnapshot = snapshot;
    const host = document.createElement('div');
    host.id = 'gptlock-context-warning-host';
    host.style.cssText = 'all:initial;position:fixed;left:50%;bottom:86px;transform:translateX(-50%);z-index:2147483647;pointer-events:auto';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .card{box-sizing:border-box;width:min(660px,calc(100vw - 32px));padding:14px 16px;border:1px solid #f59e0b;border-radius:14px;
          color:#78350f;background:#fffbeb;box-shadow:0 14px 40px rgba(120,53,15,.2);font:600 13px/1.5 system-ui,sans-serif}
        strong{display:block;margin-bottom:4px;color:#92400e;font-size:14px}.detail{font-weight:550}.learn{margin-top:6px;font-size:12px;font-weight:550;color:#92400e}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
        button{border:0;border-radius:9px;padding:8px 11px;font:700 12px/1 system-ui,sans-serif;cursor:pointer}.cancel{background:#fef3c7;color:#78350f}.send{background:#b45309;color:#fff}
      </style>
      <div class="card" role="alertdialog" aria-live="assertive">
        <strong>GPTWork 上下文预警：本次发送已拦截</strong>
        <div class="detail"></div>
        <div class="learn">如果你选择“仍然发送一次”，并且 ChatGPT 确实成功完成新答案，GPTWork 会把本次完整聊天长度记为该 ChatGPT 账户/模型的实测成功下限，并实时提高后续自适应发送预算。</div>
        <div class="actions"><button class="cancel" type="button">取消</button><button class="send" type="button">仍然发送一次</button></div>
      </div>`;
    const limitLabel = snapshot.adaptiveActive ? '当前账户自适应预算' : 'GPTWork 默认安全预算';
    root.querySelector('.detail').textContent = `当前完整聊天约 ${formatCompactTokens(snapshot.fullConversationTokens)} tokens（${formatCompactNumber(snapshot.fullConversationCharacters)} 字符），加入这条提示并预留回复后预计 ${snapshot.projectedPercent.toFixed(1)}%，将越过${limitLabel} ${formatCompactTokens(snapshot.safeLimitTokens)}。该计数为本地完整聊天估算，不是 ChatGPT 官方实时 token 计数。`;
    root.querySelector('.cancel').addEventListener('click', closeWarning);
    root.querySelector('.send').addEventListener('click', sendAfterExplicitBypass);
    document.documentElement.append(host);
    warningHost = host;
  }

  function handlePotentialSend(event) {
    if (!isPotentialSend(event)) return true;
    const now = Date.now();
    if (event.type === 'submit' && now - sendAllowedAt < SEND_DEDUPE_MS) return true;

    const draft = composerText().trim();
    if (draft.startsWith(AUTO_PROBE_PREFIX)) {
      sendAllowedAt = now;
      return true;
    }
    if (privateAuthorityReplayUntil > now) {
      privateAuthorityReplayUntil = 0;
      sendAllowedAt = now;
      return true;
    }
    if (bypassUntil > now) {
      bypassUntil = 0;
      sendAllowedAt = now;
      return true;
    }

    const authority = globalThis.__GPTLOCK_PRIVATE_CONTEXT_BUDGET_AUTHORITY__;
    if (authority?.shouldGuardSend?.()) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (privateSendCheckInFlight) return false;
      privateSendCheckInFlight = true;
      void authority.evaluateForSend().then((outcome) => {
        if (outcome?.ok && outcome.result) {
          let next = snapshotNow();
          next = authority.applyResultToSnapshot?.(next, outcome.result, outcome) || next;
          publishSnapshot(next);
          if (next.wouldExceed) showContextWarning(next);
          else replayPotentialSend();
          return;
        }
        recompute();
        const fallback = lastSnapshot;
        if (fallback?.wouldExceed) showContextWarning(fallback);
        else replayPotentialSend();
      }).catch(() => {
        recompute();
        const fallback = lastSnapshot;
        if (fallback?.wouldExceed) showContextWarning(fallback);
        else replayPotentialSend();
      }).finally(() => {
        privateSendCheckInFlight = false;
      });
      return false;
    }

    recompute();
    const snapshot = lastSnapshot;
    if (!snapshot?.wouldExceed) {
      sendAllowedAt = now;
      return true;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    showContextWarning(snapshot);
    return false;
  }

  function extractStableAccountCandidate(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const direct = [
      ['account-id', payload.account?.id],
      ['account-id', payload.account_id],
      ['account-id', payload.accountId],
      ['user-id', payload.user?.id],
      ['user-id', payload.user_id],
      ['user-id', payload.userId],
      ['user-sub', payload.user?.sub],
      ['user-sub', payload.sub],
      ['user-id', payload.user?.auth0Id],
      ['email', payload.user?.email],
      ['email', payload.email],
    ];
    for (const [source, value] of direct) {
      const normalized = String(value ?? '').trim();
      if (normalized && normalized.length <= 512) return { source, value: normalized };
    }
    if (Array.isArray(payload.accounts)) {
      for (const account of payload.accounts) {
        const value = String(account?.id ?? account?.account_id ?? account?.accountId ?? '').trim();
        if (value && value.length <= 512) return { source: 'account-id', value };
      }
    }
    return null;
  }

  async function hashAccountCandidate(source, value) {
    const data = new TextEncoder().encode(`${source}:${value}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = [...new Uint8Array(digest)].slice(0, 16);
    return `acct-${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  async function fetchAccountPayload(path) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ACCOUNT_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(new URL(path, location.origin), {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const contentType = String(response.headers.get('content-type') || '');
      if (!/json/i.test(contentType)) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function detectAccountScope() {
    for (const endpoint of ACCOUNT_ENDPOINTS) {
      const payload = await fetchAccountPayload(endpoint);
      const candidate = extractStableAccountCandidate(payload);
      if (!candidate) continue;
      try {
        return {
          scope: await hashAccountCandidate(candidate.source, candidate.value),
          source: candidate.source,
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  async function loadActiveProfile() {
    const sequence = ++profileLoadSequence;
    const model = detectModel();
    const key = profileStorageKey(currentAccountScope, model);
    lastLoadedProfileModel = model;
    if (!key) {
      activeProfile = null;
      activeProfileKey = null;
      scheduleRefresh();
      return null;
    }
    try {
      const stored = await chrome.storage.local.get(key);
      if (sequence !== profileLoadSequence) return null;
      const profile = stored[key] ?? null;
      if (
        profile
        && profile.accountScope === currentAccountScope
        && normalizeModelId(profile.model) === normalizeModelId(model)
      ) {
        activeProfile = profile;
        activeProfileKey = key;
      } else {
        activeProfile = null;
        activeProfileKey = key;
      }
    } catch {
      if (sequence !== profileLoadSequence) return null;
      activeProfile = null;
      activeProfileKey = key;
    }
    scheduleRefresh();
    return activeProfile;
  }

  async function evaluatePrivateContextProfile(event, payload = {}) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: PRIVATE_CONTEXT_PROFILE_MESSAGE_TYPE,
        payload: { event, ...payload },
      });
      return response?.ok && response.data ? response.data : null;
    } catch {
      return null;
    }
  }

  async function persistHardLimitObservation(snapshot, notice) {
    if (!snapshot || !notice || hardLimitLearningInFlight) return null;
    const model = normalizeModelId(snapshot.model) || detectModel();
    const privateBudgetAvailable = snapshot.budgetAuthority === 'private-engine';
    const observedTokens = privateBudgetAvailable ? Math.max(
      Math.ceil(Number(snapshot.fullConversationTokens) || 0),
      Math.ceil(Number(snapshot.cumulativeConversationTokens) || 0),
    ) : 0;
    const fingerprint = `${snapshot.conversationKey}:${model}:${snapshot.historyMeasurementSource}:${observedTokens}`;
    if (lastHardLimitFingerprint === fingerprint) return activeProfile;
    hardLimitLearningInFlight = true;
    try {
      if (!currentAccountScope) await refreshAccountScope(true);
      const key = profileStorageKey(currentAccountScope, model);
      if (!key) return null;
      const stored = await chrome.storage.local.get(key);
      const previous = stored[key] ?? null;
      const measurementReliable = privateBudgetAvailable && ['conversation-tree+dom-reconcile', 'checkpoint+dom-restore'].includes(snapshot.historyMeasurementSource);
      const observedCharacters = Math.max(snapshot.fullConversationCharacters || 0, snapshot.cumulativeConversationCharacters || 0);
      const observedMessages = Math.max(snapshot.messageCount || 0, snapshot.cumulativeMessageCount || 0);
      const measuredAt = new Date().toISOString();
      const privateNumbers = privateBudgetAvailable
        ? await evaluatePrivateContextProfile('hard_limit', {
          model,
          previous,
          observedConversationTokens: observedTokens,
          measurementReliable,
        })
        : null;
      let next;
      if (privateNumbers) {
        next = {
          ...(previous && typeof previous === 'object' ? previous : {}),
          schemaVersion: 1,
          accountScope: currentAccountScope,
          accountScopeSource: currentAccountScopeSource || 'unknown',
          model,
          hardLimitObserved: true,
          hardLimitObservedCount: privateNumbers.hardLimitObservedCount,
          hardLimitObservedTokens: observedTokens,
          hardLimitObservedCharacters: Math.max(0, Math.ceil(Number(observedCharacters) || 0)),
          hardLimitObservedMessages: Math.max(0, Math.ceil(Number(observedMessages) || 0)),
          hardLimitUpperBoundTokens: privateNumbers.hardLimitUpperBoundTokens,
          hardLimitTokenCapUsable: privateNumbers.hardLimitTokenCapUsable,
          hardLimitConfidence: privateNumbers.hardLimitConfidence,
          hardLimitMeasurementSource: String(snapshot.historyMeasurementSource || 'unknown').slice(0, 80),
          hardLimitLastObservedAt: measuredAt,
          hardLimitLastConversationKey: String(snapshot.conversationKey || 'unknown').slice(0, 256),
          hardLimitLastText: String(notice.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          hardLimitActionText: String(notice.actionText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          hardLimitEvidence: 'chatgpt-visible-conversation-length-limit',
          numericDerivation: 'private-engine',
        };
      } else {
        next = {
          ...(previous && typeof previous === 'object' ? previous : {}),
          schemaVersion: 1,
          accountScope: currentAccountScope,
          accountScopeSource: currentAccountScopeSource || 'unknown',
          model,
          hardLimitObserved: true,
          hardLimitObservedCount: Math.max(0, Math.floor(Number(previous?.hardLimitObservedCount) || 0)) + 1,
          hardLimitObservedTokens: storedMetric(observedTokens),
          hardLimitObservedCharacters: Math.max(0, Math.ceil(Number(observedCharacters) || 0)),
          hardLimitObservedMessages: Math.max(0, Math.ceil(Number(observedMessages) || 0)),
          hardLimitUpperBoundTokens: storedMetric(previous?.hardLimitUpperBoundTokens),
          hardLimitTokenCapUsable: previous?.hardLimitTokenCapUsable === true,
          hardLimitConfidence: 'ui-boundary-only',
          hardLimitMeasurementSource: String(snapshot.historyMeasurementSource || 'unknown').slice(0, 80),
          hardLimitLastObservedAt: measuredAt,
          hardLimitLastConversationKey: String(snapshot.conversationKey || 'unknown').slice(0, 256),
          hardLimitLastText: String(notice.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          hardLimitActionText: String(notice.actionText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          hardLimitEvidence: 'chatgpt-visible-conversation-length-limit',
          numericDerivation: 'unavailable',
        };
      }
      if (!next) return null;
      await chrome.storage.local.set({ [key]: next });
      activeProfile = next;
      activeProfileKey = key;
      lastLoadedProfileModel = model;
      lastHardLimitFingerprint = fingerprint;
      await discardPendingBypass();
      window.dispatchEvent(new CustomEvent('gptlock:context-hard-limit-learned', {
        detail: {
          model,
          conversationKey: snapshot.conversationKey,
          hardLimitUpperBoundTokens: next.hardLimitUpperBoundTokens || 0,
          observedConversationTokens: observedTokens,
          confidence: next.hardLimitConfidence,
          measurementSource: snapshot.historyMeasurementSource,
        },
      }));
      showHardLimitToast(next);
      scheduleRefresh();
      return next;
    } catch {
      return null;
    } finally {
      hardLimitLearningInFlight = false;
    }
  }

  async function refreshAccountScope(force = false) {
    const now = Date.now();
    if (!force && now - accountScopeCheckedAt < ACCOUNT_SCOPE_REFRESH_MS) return currentAccountScope;
    if (accountScopePromise) return accountScopePromise;
    accountScopePromise = (async () => {
      const detected = await detectAccountScope();
      accountScopeCheckedAt = Date.now();
      const nextScope = detected?.scope ?? null;
      const nextSource = detected?.source ?? null;
      const changed = nextScope !== currentAccountScope || nextSource !== currentAccountScopeSource;
      currentAccountScope = nextScope;
      currentAccountScopeSource = nextSource;
      if (changed) {
        await loadActiveProfile();
        await loadConversationCheckpoint();
        await restorePendingBypass();
      }
      return currentAccountScope;
    })().finally(() => {
      accountScopePromise = null;
    });
    return accountScopePromise;
  }

  function bindPendingToGuardState(state) {
    if (!pendingBypass) return;
    const age = Date.now() - pendingBypass.startedAt;
    if (age > BYPASS_OBSERVATION_TIMEOUT_MS) {
      pendingBypass = null;
      return;
    }
    if (pendingBypass.conversationKey !== currentConversationKey()) {
      pendingBypass = null;
      return;
    }

    const request = state?.lastRequest;
    if (request?.requestId) {
      const capturedAt = Date.parse(request.capturedAt || '') || 0;
      if (capturedAt >= pendingBypass.startedAt - 1_500) {
        if (!pendingBypass.requestId || pendingBypass.requestId === request.requestId) {
          pendingBypass.requestId = request.requestId;
          pendingBypass.requestObserved = true;
          pendingBypass.model = normalizeModelId(request.model) || pendingBypass.model;
        }
      }
    }

    if (!pendingBypass.requestObserved) return;
    void persistPendingBypassState();
    if (state?.phase === 'error' && state?.lastError) {
      pendingBypass.responseSeen = true;
      pendingBypass.responseSuccessful = false;
      void persistPendingBypassState();
      return;
    }
    if (state?.lastEvidenceDiagnostics) {
      const status = Number(state.lastEvidenceDiagnostics.httpStatus);
      pendingBypass.responseSeen = true;
      pendingBypass.responseSuccessful = !Number.isFinite(status) || status === 0 || (status >= 200 && status < 400);
      void persistPendingBypassState();
    }
  }

  function responseCanBeConsideredSuccessful() {
    if (!pendingBypass?.requestObserved) return false;
    if (pendingBypass.responseSuccessful === false) return false;
    if (pendingBypass.responseSuccessful === true) return true;
    if (lastGuardState?.phase === 'waiting' || lastGuardState?.phase === 'error') return false;
    return true;
  }

  async function persistLearnedProfile(postSnapshot) {
    if (!pendingBypass || pendingBypass.learningStarted) return null;
    pendingBypass.learningStarted = true;
    const accountScope = pendingBypass.accountScope || currentAccountScope;
    const accountScopeSource = pendingBypass.accountScopeSource || currentAccountScopeSource || 'unknown';
    const model = normalizeModelId(pendingBypass.model) || normalizeModelId(postSnapshot.model);
    const key = profileStorageKey(accountScope, model);
    if (!key) {
      await discardPendingBypass();
      return null;
    }
    // A successful answer proves the input accepted at send time, not the answer-inclusive post state.
    const confirmedConversationTokens = Math.ceil(pendingBypass.preSnapshot?.usedTokens || 0);
    const confirmedCharacters = pendingBypass.preSnapshot?.fullConversationCharacters || 0;
    const measuredAt = new Date().toISOString();
    try {
      const stored = await chrome.storage.local.get(key);
      const previous = stored[key] ?? null;
      const privateNumbers = await evaluatePrivateContextProfile('successful_bypass', {
        model,
        previous,
        confirmedConversationTokens,
        confirmedCharacters,
      });
      if (!privateNumbers) {
        await discardPendingBypass();
        return null;
      }
      const next = {
        ...(previous && typeof previous === 'object' ? previous : {}),
        schemaVersion: 1,
        accountScope,
        accountScopeSource,
        model,
        confirmedConversationTokens: privateNumbers.confirmedConversationTokens,
        confirmedCharacters: privateNumbers.confirmedCharacters,
        adaptiveSafeLimitTokens: privateNumbers.adaptiveSafeLimitTokens,
        successfulBypassCount: privateNumbers.successfulBypassCount,
        firstConfirmedAt: previous?.firstConfirmedAt || measuredAt,
        lastConfirmedAt: measuredAt,
        lastConversationKey: String(postSnapshot.conversationKey || 'unknown').slice(0, 256),
        evidence: 'explicit-over-limit-send+formal-request+settled-assistant-turn',
        numericDerivation: 'private-engine',
      };
      await chrome.storage.local.set({ [key]: next });
      activeProfile = next;
      activeProfileKey = key;
      lastLoadedProfileModel = model;
      const detail = {
        model,
        confirmedConversationTokens: next.confirmedConversationTokens,
        adaptiveSafeLimitTokens: next.adaptiveSafeLimitTokens,
        successfulBypassCount: next.successfulBypassCount,
      };
      await discardPendingBypass();
      window.dispatchEvent(new CustomEvent('gptlock:context-limit-learned', { detail }));
      showLearningToast(next);
      recompute();
      return next;
    } catch {
      await discardPendingBypass();
      return null;
    }
  }

  async function maybeFinalizeBypassLearning() {
    const pending = pendingBypass;
    if (!pending || pending.learningStarted) return;
    if (Date.now() - pending.startedAt > BYPASS_OBSERVATION_TIMEOUT_MS) {
      await discardPendingBypass();
      return;
    }
    if (pending.conversationKey !== currentConversationKey()) {
      pendingBypass = null;
      return;
    }
    if (!pending.requestObserved) return;
    if (pending.responseSuccessful === false) {
      await discardPendingBypass();
      return;
    }
    if (isGenerating()) {
      pending.stableSignature = null;
      pending.stableSince = 0;
      return;
    }
    if (hasVisibleGenerationError()) {
      await discardPendingBypass();
      return;
    }
    const assistant = assistantStats();
    if (assistant.count <= pending.baselineAssistantCount || assistant.lastCharacters <= 0) return;
    const signature = `${assistant.count}:${assistant.lastCharacters}`;
    if (signature !== pending.stableSignature) {
      pending.stableSignature = signature;
      pending.stableSince = Date.now();
      return;
    }
    if (Date.now() - pending.stableSince < RESPONSE_SETTLE_MS) return;
    if (!responseCanBeConsideredSuccessful()) return;

    if (!pending.accountScope) {
      await refreshAccountScope(true);
      if (!pendingBypass) return;
      pending.accountScope = currentAccountScope;
      pending.accountScopeSource = currentAccountScopeSource;
    }
    if (!pending.accountScope) return;

    await refreshConversationMetrics(true);
    recomputeSnapshotOnly();
    const postSnapshot = lastSnapshot;
    if (!postSnapshot) return;
    await persistLearnedProfile(postSnapshot);
  }

  function recomputeSnapshotOnly() {
    try {
      publishSnapshot(snapshotNow());
    } catch {
      // Ignore a transient DOM replacement.
    }
  }

  function showLearningToast(profile) {
    const existing = document.getElementById('gptlock-context-learning-toast');
    existing?.remove();
    const host = document.createElement('div');
    host.id = 'gptlock-context-learning-toast';
    host.style.cssText = 'all:initial;position:fixed;right:18px;bottom:86px;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .toast{max-width:420px;padding:11px 13px;border-radius:12px;background:#ecfdf5;color:#065f46;border:1px solid #6ee7b7;
          box-shadow:0 12px 30px rgba(6,95,70,.16);font:650 12px/1.45 system-ui,sans-serif}
      </style>
      <div class="toast"></div>`;
    root.querySelector('.toast').textContent = `GPTWork 已学习本次成功超限聊天：${profile.model} 实测成功下限约 ${formatCompactTokens(profile.confirmedConversationTokens)}，该账户后续自适应发送预算已提高到约 ${formatCompactTokens(profile.adaptiveSafeLimitTokens)} tokens。`;
    document.documentElement.append(host);
    window.setTimeout(() => host.remove(), 6_000);
  }

  function showHardLimitToast(profile) {
    const existing = document.getElementById('gptlock-context-hard-limit-toast');
    existing?.remove();
    const host = document.createElement('div');
    host.id = 'gptlock-context-hard-limit-toast';
    host.style.cssText = 'all:initial;position:fixed;right:18px;bottom:86px;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>.toast{max-width:460px;padding:11px 13px;border-radius:12px;background:#fff7ed;color:#9a3412;border:1px solid #fdba74;box-shadow:0 12px 30px rgba(154,52,18,.14);font:650 12px/1.45 system-ui,sans-serif}</style>
      <div class="toast"></div>`;
    const upper = storedMetric(profile?.hardLimitUpperBoundTokens);
    root.querySelector('.toast').textContent = upper
      ? `GPTWork 已捕获 ChatGPT 真实“对话长度上限”提示，并记录该账户/模型的实测上界 ≤ ${formatCompactTokens(upper)} tokens。后续发送预算会同时受成功下限与该上界约束。`
      : 'GPTWork 已捕获 ChatGPT 真实“对话长度上限”提示。当前会话历史只能从 DOM 回退估算，数据不完整，因此不会把这个不完整 token 数误写成最大上限；事件已记录，后续会继续对账。';
    document.documentElement.append(host);
    window.setTimeout(() => host.remove(), 7_000);
  }

  document.addEventListener('click', handlePotentialSend, true);
  document.addEventListener('keydown', handlePotentialSend, true);
  document.addEventListener('submit', handlePotentialSend, true);
  document.addEventListener('input', scheduleRefresh, true);

  chrome?.runtime?.onMessage?.addListener?.((message) => {
    if (message?.type !== 'GPTLOCK_GUARD_STATE') return false;
    const state = message.state;
    lastGuardState = state ?? null;
    const previousModel = detectModel();
    lastKnownModel = normalizeModelId(
      state?.lastVerification?.model
      || state?.lastRequest?.model
      || state?.pageObservation?.model
      || lastKnownModel,
    );
    bindPendingToGuardState(state);
    const nextModel = detectModel();
    if (normalizeModelId(previousModel) !== normalizeModelId(nextModel) || normalizeModelId(lastLoadedProfileModel) !== normalizeModelId(nextModel)) {
      void loadActiveProfile();
      void loadConversationCheckpoint();
      void restorePendingBypass();
    }
    if (!currentAccountScope) void refreshAccountScope();
    scheduleRefresh();
    void maybeFinalizeBypassLearning();
    return false;
  });

  chrome?.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== 'local' || !activeProfileKey || !changes[activeProfileKey]) return;
    const profile = changes[activeProfileKey].newValue ?? null;
    if (
      profile
      && profile.accountScope === currentAccountScope
      && normalizeModelId(profile.model) === normalizeModelId(detectModel())
    ) {
      activeProfile = profile;
    } else {
      activeProfile = null;
    }
    scheduleRefresh();
  });

  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  function resetConversationScopedState() {
    // Detach only. The old conversation's pending record remains recoverable until its TTL expires.
    pendingBypass = null;
    restoredPendingKey = null;
    restoredCheckpoint = null;
    restoredCheckpointKey = null;
    checkpointLoadSequence += 1;
    conversationMetricsRequestSequence += 1;
    conversationMetricsPromise = null;
    conversationMetricsPromiseKey = null;
    conversationMetricsCache = null;
    conversationMetricsCheckedAt = 0;
    lastHardLimitNotice = null;
    lastHardLimitFingerprint = null;
  }

  function handleConversationNavigation() {
    const nextConversationKey = currentConversationKey();
    if (observedConversationKey === nextConversationKey) return false;
    observedConversationKey = nextConversationKey;
    resetConversationScopedState();
    scheduleRefresh();
    void refreshAccountScope(true).then(() => {
      if (observedConversationKey !== nextConversationKey) return;
      void loadConversationCheckpoint();
      void restorePendingBypass();
    });
    void refreshConversationMetrics(true);
    return true;
  }

  function ensureConversationNavigation() {
    const nextConversationKey = currentConversationKey();
    if (observedConversationKey === null) {
      observedConversationKey = nextConversationKey;
      return false;
    }
    if (observedConversationKey === nextConversationKey) return false;
    return handleConversationNavigation();
  }

  observedConversationKey = currentConversationKey();
  window.addEventListener('popstate', handleConversationNavigation);
  window.addEventListener('hashchange', handleConversationNavigation);
  window.addEventListener('resize', scheduleRefresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ensureConversationNavigation();
      void refreshAccountScope(true);
      void refreshConversationMetrics(true);
    }
  });
  // DOM/input/guard events already keep the budget current. The former 1.5s full
  // recompute forced layout/history work even while the user was only moving the
  // browser window. Keep only a low-frequency self-heal and schedule it through
  // the normal debounce path.
  window.setInterval(scheduleRefresh, PERIODIC_REFRESH_MS);
  void refreshAccountScope(true).then(() => {
    void loadConversationCheckpoint();
    void restorePendingBypass();
  });
  void refreshConversationMetrics(true);
  recompute();
})();