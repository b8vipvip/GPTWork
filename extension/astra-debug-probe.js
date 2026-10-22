// A diagnostic request is an explicit, one-shot transport experiment.
// Request success and actual served-model proof are deliberately independent.
export const ASTRA_DEBUG_TRANSPORT = 'gpt-6-astra-wm';
export const ASTRA_DEBUG_PROMPT = '计算 12×13，只输出整数。';

export function isAstraDebugRequest(postData) {
  if (typeof postData !== 'string' || postData.length > 2 * 1024 * 1024) return false;
  try {
    const payload = JSON.parse(postData);
    return Array.isArray(payload?.messages) && payload.messages.some((message) => {
      if (message?.author?.role && message.author.role !== 'user') return false;
      const parts = message?.content?.parts;
      return Array.isArray(parts) && parts.some((part) =>
        part === ASTRA_DEBUG_PROMPT
        || part?.text === ASTRA_DEBUG_PROMPT
        || part?.content === ASTRA_DEBUG_PROMPT);
    });
  } catch {
    return false;
  }
}
export function detectAstraDebugSseTerminal(body) {
  if (typeof body !== 'string' || body.length > 4 * 1024 * 1024) return false;
  return /(?:^|\n)\s*data:\s*\[DONE\]\s*(?:\r?\n|$)/i.test(body)
    || /(?:^|\n)\s*event:\s*(?:done|message_stream_complete)\s*(?:\r?\n|$)/i.test(body);
}

export const ASTRA_DEBUG_CANONICAL = 'gpt-6-astra';
export const ASTRA_DEBUG_TIMEOUT_MS = 180000;
export const ASTRA_DEBUG_HISTORY_KEY = 'gptworkAstraDebugProbeHistoryV1';

export function astraDebugConfiguration(base, probe, requestId = null) {
  if (!probe || probe.phase !== 'dispatching'
    || (probe.claimed === true && (!requestId || probe.claimedFetchRequestId !== requestId))) return null;
  return {
    ...base,
    lockedModels: [ASTRA_DEBUG_CANONICAL],
    knownModels: [...new Set([...(base.knownModels || []), ASTRA_DEBUG_CANONICAL])],
    forceModel: ASTRA_DEBUG_CANONICAL,
    forceTransportModel: ASTRA_DEBUG_TRANSPORT,
    preferredReasoning: null,
    preserveModel: false,
    preserveReasoning: true,
    bypassRewrite: false,
    responseVerificationEnabled: true,
    authorityKind: 'debug-astra-transport',
    authorityModel: ASTRA_DEBUG_CANONICAL,
    authorityRequestModel: ASTRA_DEBUG_CANONICAL,
    authorityTransportModel: ASTRA_DEBUG_TRANSPORT,
    authorityStartedAt: probe.startedAt,
  };
}

export function astraDebugVerdict(probe) {
  const status = Number(probe?.httpStatus);
  const terminal = probe?.terminalEvent;
  const requestAccepted = probe?.forwardedTransportModel === ASTRA_DEBUG_TRANSPORT;
  const httpSuccess = status >= 200 && status < 300;
  const completed = terminal === 'conversation_response_finished';
  const failed = terminal === 'conversation_response_failed' || (status >= 400 && status <= 599);
  const servedModel = probe?.responseModel ?? null;
  return {
    requestAccepted,
    httpSuccess,
    responseCompleted: completed,
    requestOutcome: !requestAccepted ? 'not_forwarded'
      : failed ? 'failed'
      : completed && httpSuccess ? 'transport_completed'
      : status >= 200 ? 'awaiting_stream_terminal'
      : 'awaiting_response',
    modelVerdict: !servedModel ? 'unverified'
      : servedModel === ASTRA_DEBUG_CANONICAL ? 'astra_confirmed' : 'different_model',
  };
}

export function publicAstraDebugProbe(probe) {
  if (!probe) return null;
  const fields = [
    'id', 'tabId', 'contextKey', 'phase', 'startedAt', 'updatedAt',
    'requestId', 'fetchRequestId', 'pageModel', 'originalTransportModel',
    'forwardedTransportModel', 'httpStatus', 'mimeType', 'terminalEvent',
    'responseModel', 'responseModelField', 'responseDefaultModel',
    'responseEvidenceSource', 'streamStage', 'sseTerminalObserved', 'networkError',
    'sendMethod', 'assistantSettled', 'responseTextSnippet', 'error',
  ];
  const safe = Object.fromEntries(fields.map((key) => [key, probe[key] ?? null]));
  return { ...safe, targetTransportModel: ASTRA_DEBUG_TRANSPORT, ...astraDebugVerdict(probe) };
}
