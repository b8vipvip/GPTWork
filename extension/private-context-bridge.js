import { privateCoreChannel } from './private-core-channel.js';

const BUDGET_MESSAGE_TYPE = 'GPTLOCK_PRIVATE_CONTEXT_BUDGET';
const PROFILE_MESSAGE_TYPE = 'GPTLOCK_PRIVATE_CONTEXT_PROFILE';
const MAX_METRIC = Number.MAX_SAFE_INTEGER;
const MAX_HISTORY_PARTS = 20_000;
const MAX_TOTAL_TEXT_CHARS = 16 * 1024 * 1024;
const MAX_MEDIA_PER_PART = 32;

function boundedMetric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(MAX_METRIC, Math.floor(number));
}

function boundedCount(value, max = MAX_MEDIA_PER_PART) {
  const metric = boundedMetric(value);
  return metric === null ? 0 : Math.min(max, metric);
}

function normalizeModel(value) {
  const model = String(value ?? '').trim().toLowerCase();
  if (!model || model.length > 128 || !/^[a-z0-9._:-]+$/.test(model)) return null;
  return model;
}

function sanitizeTextPart(value = {}) {
  const text = typeof value?.text === 'string' ? value.text : '';
  return {
    text,
    images: boundedCount(value?.images),
    attachments: boundedCount(value?.attachments),
  };
}

export function sanitizePrivateContextProfilePayload(value = {}) {
  const event = String(value?.event ?? '').trim();
  if (!['successful_bypass', 'hard_limit'].includes(event)) {
    throw new TypeError('private context profile event is invalid');
  }
  const previous = value?.previous && typeof value.previous === 'object' ? value.previous : {};
  return {
    event,
    model: normalizeModel(value?.model),
    previous: {
      confirmedConversationTokens: boundedMetric(previous.confirmedConversationTokens),
      confirmedCharacters: boundedMetric(previous.confirmedCharacters),
      adaptiveSafeLimitTokens: boundedMetric(previous.adaptiveSafeLimitTokens),
      successfulBypassCount: boundedMetric(previous.successfulBypassCount),
      hardLimitUpperBoundTokens: boundedMetric(previous.hardLimitUpperBoundTokens),
      hardLimitObservedCount: boundedMetric(previous.hardLimitObservedCount),
    },
    confirmedConversationTokens: boundedMetric(value?.confirmedConversationTokens),
    confirmedCharacters: boundedMetric(value?.confirmedCharacters),
    observedConversationTokens: boundedMetric(value?.observedConversationTokens),
    measurementReliable: value?.measurementReliable === true,
  };
}

export function normalizePrivateContextProfileResult(value) {
  const confidence = String(value?.hardLimitConfidence ?? '').trim();
  if (!['measured-upper-bound', 'ui-boundary-only'].includes(confidence)) {
    throw new TypeError('private context profile confidence is invalid');
  }
  return {
    confirmedConversationTokens: requiredMetric(value?.confirmedConversationTokens, 'confirmedConversationTokens'),
    confirmedCharacters: requiredMetric(value?.confirmedCharacters, 'confirmedCharacters'),
    adaptiveSafeLimitTokens: requiredMetric(value?.adaptiveSafeLimitTokens, 'adaptiveSafeLimitTokens'),
    successfulBypassCount: requiredMetric(value?.successfulBypassCount, 'successfulBypassCount'),
    hardLimitUpperBoundTokens: requiredMetric(value?.hardLimitUpperBoundTokens, 'hardLimitUpperBoundTokens'),
    hardLimitObservedCount: requiredMetric(value?.hardLimitObservedCount, 'hardLimitObservedCount'),
    hardLimitTokenCapUsable: value?.hardLimitTokenCapUsable === true,
    hardLimitConfidence: confidence,
  };
}

export function sanitizePrivateContextBudgetPayload(value = {}) {
  const rawHistory = Array.isArray(value?.history) ? value.history : [];
  if (rawHistory.length > MAX_HISTORY_PARTS) {
    throw new RangeError('private context history contains too many parts');
  }
  const history = rawHistory.map(sanitizeTextPart);
  const draft = sanitizeTextPart(value?.draft);
  let totalChars = draft.text.length;
  for (const part of history) {
    totalChars += part.text.length;
    if (totalChars > MAX_TOTAL_TEXT_CHARS) {
      throw new RangeError('private context text exceeds local evaluation limit');
    }
  }
  if (totalChars > MAX_TOTAL_TEXT_CHARS) {
    throw new RangeError('private context text exceeds local evaluation limit');
  }
  const profile = value?.profile && typeof value.profile === 'object' ? value.profile : {};
  return {
    model: normalizeModel(value?.model),
    history,
    draft,
    profile: {
      adaptiveSafeLimitTokens: boundedMetric(profile.adaptiveSafeLimitTokens),
      hardLimitUpperBoundTokens: boundedMetric(profile.hardLimitUpperBoundTokens),
      confirmedConversationTokens: boundedMetric(profile.confirmedConversationTokens),
    },
  };
}

function requiredMetric(value, name) {
  const metric = boundedMetric(value);
  if (metric === null) throw new TypeError(`private context budget ${name} is invalid`);
  return metric;
}

function requiredPercent(value, name, max = 999) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`private context budget ${name} is invalid`);
  }
  return Math.min(max, number);
}

export function normalizePrivateContextBudgetResult(value) {
  const source = String(value?.contextWindowSource ?? '').trim();
  if (!source || source.length > 96) {
    throw new TypeError('private context budget source is invalid');
  }
  return {
    nominalLimitTokens: requiredMetric(value?.nominalLimitTokens, 'nominalLimitTokens'),
    baseSafeLimitTokens: requiredMetric(value?.baseSafeLimitTokens, 'baseSafeLimitTokens'),
    adaptiveSafeLimitTokens: requiredMetric(value?.adaptiveSafeLimitTokens, 'adaptiveSafeLimitTokens'),
    hardLimitUpperBoundTokens: requiredMetric(value?.hardLimitUpperBoundTokens, 'hardLimitUpperBoundTokens'),
    confirmedLowerBoundTokens: requiredMetric(value?.confirmedLowerBoundTokens, 'confirmedLowerBoundTokens'),
    safeLimitTokens: requiredMetric(value?.safeLimitTokens, 'safeLimitTokens'),
    reserveTokens: requiredMetric(value?.reserveTokens, 'reserveTokens'),
    historyTokens: requiredMetric(value?.historyTokens, 'historyTokens'),
    draftTokens: requiredMetric(value?.draftTokens, 'draftTokens'),
    usedTokens: requiredMetric(value?.usedTokens, 'usedTokens'),
    projectedTokens: requiredMetric(value?.projectedTokens, 'projectedTokens'),
    percentUsed: requiredPercent(value?.percentUsed, 'percentUsed'),
    projectedPercent: requiredPercent(value?.projectedPercent, 'projectedPercent'),
    remainingPercent: requiredPercent(value?.remainingPercent, 'remainingPercent', 100),
    remainingTokens: requiredMetric(value?.remainingTokens, 'remainingTokens'),
    warning: Boolean(value?.warning),
    wouldExceed: Boolean(value?.wouldExceed),
    adaptiveActive: Boolean(value?.adaptiveActive),
    hardLimitActive: Boolean(value?.hardLimitActive),
    contextWindowSource: source,
  };
}

function safeErrorCode(error) {
  const code = String(error?.code || '').trim();
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code : 'private_context_unavailable';
}

function senderWindowKey(sender) {
  return Number.isInteger(sender?.tab?.windowId) ? `chrome:${sender.tab.windowId}` : null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (![BUDGET_MESSAGE_TYPE, PROFILE_MESSAGE_TYPE].includes(message?.type)) return false;

  void (async () => {
    try {
      const windowKey = senderWindowKey(sender);
      if (message.type === PROFILE_MESSAGE_TYPE) {
        if (!(await privateCoreChannel.supports('contextProfileEvaluation'))) {
          sendResponse({ ok: false, error: 'private_context_profile_unsupported' });
          return;
        }
        const profileEvaluation = sanitizePrivateContextProfilePayload(message.payload);
        const raw = await privateCoreChannel.request(
          'evaluate_context',
          { mode: 'profile', profileEvaluation },
          'context-profile',
          { windowKey },
        );
        sendResponse({ ok: true, data: normalizePrivateContextProfileResult(raw) });
        return;
      }
      if (message.type === BUDGET_MESSAGE_TYPE) {
        if (!(await privateCoreChannel.supports('contextBudgetEvaluation'))) {
          sendResponse({ ok: false, error: 'private_context_budget_unsupported' });
          return;
        }
        const budget = sanitizePrivateContextBudgetPayload(message.payload);
        const raw = await privateCoreChannel.request(
          'evaluate_context',
          { mode: 'budget', budget },
          'context-budget',
          { windowKey },
        );
        sendResponse({ ok: true, data: normalizePrivateContextBudgetResult(raw) });
        return;
      }
    } catch (error) {
      privateCoreChannel.invalidate();
      sendResponse({ ok: false, error: safeErrorCode(error) });
    }
  })();

  return true;
});

export {
  BUDGET_MESSAGE_TYPE as PRIVATE_CONTEXT_BUDGET_MESSAGE_TYPE,
  PROFILE_MESSAGE_TYPE as PRIVATE_CONTEXT_PROFILE_MESSAGE_TYPE,
};
