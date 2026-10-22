// A diagnostic request is an explicit, one-shot transport experiment.
// Request success and actual served-model proof are deliberately independent.
export const ASTRA_DEBUG_TRANSPORT = 'gpt-6-astra-wm';
export const ASTRA_DEBUG_CANONICAL = 'gpt-6-astra';
export const ASTRA_DEBUG_TIMEOUT_MS = 180000;
export const ASTRA_DEBUG_HISTORY_KEY = 'gptworkAstraDebugProbeHistoryV1';

export function astraDebugConfiguration(base, probe) {
  if (!probe || probe.phase !== 'dispatching' || probe.claimed === true) return null;
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
    'responseEvidenceSource', 'streamStage', 'networkError',
    'sendMethod', 'assistantSettled', 'error',
  ];
  const safe = Object.fromEntries(fields.map((key) => [key, probe[key] ?? null]));
  return { ...safe, targetTransportModel: ASTRA_DEBUG_TRANSPORT, ...astraDebugVerdict(probe) };
}
