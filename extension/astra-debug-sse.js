// Content-free classification of an individual Astra debug SSE capture.
// It never returns response text, request content, or arbitrary server error messages.
// A [DONE] transport marker is separate from an assistant final turn and from CDP's
// Network.loadingFinished: it cannot override Network.loadingFailed.
const MAX_SSE_BYTES = 4 * 1024 * 1024;
const MAX_SSE_EVENTS = 4000;
const ALLOWED_STATUSES = new Set([
  'finished_successfully', 'finished_with_errors', 'in_progress',
  'pending', 'interrupted', 'cancelled',
]);
const TERMINAL_EVENTS = new Set(['done', 'message_stream_complete']);

export function analyzeAstraDebugSse(body) {
  const result = {
    sseDataEvents: 0,
    sseJsonEvents: 0,
    sseTerminalKind: null,
    sseApplicationErrorSeen: false,
    sseAssistantMessageSeen: false,
    // finished_successfully can belong to an intermediate assistant message.
    // Only a matching end_turn=true confirms an assistant turn-final signal.
    sseAssistantFinalSeen: false,
    sseAssistantEndTurnSeen: false,
    sseAssistantStatus: null, // status of the most recent assistant packet
    sseAssistantStatusSequence: [], // allowed enum transitions, no message IDs/text
    sseCaptureTruncated: false,
  };
  if (typeof body !== 'string' || !body) return result;
  if (body.length > MAX_SSE_BYTES) {
    result.sseCaptureTruncated = true;
    return result;
  }

  let eventName = null;
  let dataLines = [];
  let dispatched = 0;
  const flush = () => {
    if (!eventName && !dataLines.length) return;
    if (dispatched >= MAX_SSE_EVENTS) {
      result.sseCaptureTruncated = true;
      eventName = null;
      dataLines = [];
      return;
    }
    dispatched += 1;
    const data = dataLines.join('\n').trim();
    const name = eventName;
    eventName = null;
    dataLines = [];
    if (TERMINAL_EVENTS.has(name) && !result.sseTerminalKind) result.sseTerminalKind = 'event_done';
    if (name === 'error') result.sseApplicationErrorSeen = true;
    if (!data) return;
    result.sseDataEvents += 1;
    if (data === '[DONE]') {
      result.sseTerminalKind = 'data_done';
      return;
    }
    if (data.length > 1024 * 1024) {
      result.sseCaptureTruncated = true;
      return;
    }
    let entry;
    try { entry = JSON.parse(data); } catch { return; }
    if (!entry || typeof entry !== 'object') return;
    result.sseJsonEvents += 1;
    const kind = String(entry.type || entry.event || entry.v?.type || '').toLowerCase();
    if (kind === 'error' || kind === 'conversation_error'
      || entry.error && typeof entry.error === 'object') {
      result.sseApplicationErrorSeen = true;
    }
    if (TERMINAL_EVENTS.has(kind) && !result.sseTerminalKind) result.sseTerminalKind = 'event_done';
    const message = entry.message && typeof entry.message === 'object' ? entry.message
      : entry.v?.message && typeof entry.v.message === 'object' ? entry.v.message : null;
    if (message?.author?.role !== 'assistant') return;
    result.sseAssistantMessageSeen = true;
    const status = message.status;
    if (ALLOWED_STATUSES.has(status)) {
      result.sseAssistantStatus = status;
      const sequence = result.sseAssistantStatusSequence;
      if (sequence[sequence.length - 1] !== status && sequence.length < 16) {
        sequence.push(status);
      }
      if (status === 'finished_successfully') {
        result.sseAssistantFinalSeen = true;
        if (message.end_turn === true) result.sseAssistantEndTurnSeen = true;
      }
      if (status === 'finished_with_errors') result.sseApplicationErrorSeen = true;
    }
  };
  for (const line of body.split(/\r?\n/)) {
    if (dispatched >= MAX_SSE_EVENTS) {
      result.sseCaptureTruncated = true;
      break;
    }
    if (!line.trim()) {
      flush();
    } else if (line.startsWith('event:')) {
      eventName = line.slice(6).trim().toLowerCase().slice(0, 70);
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (!result.sseCaptureTruncated) flush();
  return result;
}


// Read-only same-protocol comparator for regular ChatGPT conversations. Keep
// this on the response path only; never change request routing or verification.
// It returns a bounded allowlist, never a raw response body or user content.
export function normalChatSseBaseline(evidence, debugRequestId = null) {
  const stage = evidence?.diagnostics?.stage;
  const requestId = evidence?.streamContext?.initialRequestId || evidence?.requestId || null;
  if (!requestId || requestId === debugRequestId
    || !['initial_conversation', 'initial_conversation_aborted'].includes(stage)) return null;
  // Some normal-response paths provide parsed model evidence but do not pass
  // the raw SSE buffer through to the observer. Do not silently drop the
  // baseline, and do not fabricate negative application/final evidence.
  const bodyAvailable = typeof evidence?.rawResponseBody === 'string'
    && evidence.rawResponseBody.length > 0;
  const sse = bodyAvailable ? analyzeAstraDebugSse(evidence.rawResponseBody) : {
    sseDataEvents: null,
    sseJsonEvents: null,
    sseTerminalKind: null,
    sseApplicationErrorSeen: null,
    sseAssistantMessageSeen: null,
    sseAssistantFinalSeen: null,
    sseAssistantEndTurnSeen: null,
    sseAssistantStatus: null,
    sseAssistantStatusSequence: null,
    sseCaptureTruncated: null,
  };
  return {
    requestId: String(requestId).slice(0, 100),
    stage,
    sseEvidenceAvailable: bodyAvailable,
    sseUnavailableReason: bodyAvailable ? null
      : Number(evidence?.diagnostics?.streamCaptureBytes || 0) > 0
        ? 'response_body_not_exposed_to_observer' : 'response_body_not_captured',
    networkTerminal: ['loadingFailed', 'loadingFinished'].includes(evidence?.diagnostics?.terminalEvent)
      ? evidence.diagnostics.terminalEvent
      : stage === 'initial_conversation_aborted' ? 'loadingFailed' : null,
    httpStatus: Number.isFinite(evidence.status) ? evidence.status
      : Number.isFinite(evidence.diagnostics?.httpStatus) ? evidence.diagnostics.httpStatus : null,
    networkError: evidence.diagnostics?.networkError === 'net::ERR_ABORTED'
      ? 'net::ERR_ABORTED' : evidence.diagnostics?.networkError ? 'other_network_error' : null,
    transportEndedNormally: stage === 'initial_conversation'
      && !evidence.diagnostics?.networkError,
    servedModel: typeof evidence?.model === 'string'
      && /^gpt-[a-z0-9.:-]{1,90}$/i.test(evidence.model)
      ? evidence.model : null,
    streamHandoffSeen: Boolean(evidence.diagnostics?.streamHandoff),
    streamCaptureBytes: Number.isFinite(evidence.diagnostics?.streamCaptureBytes)
      ? evidence.diagnostics.streamCaptureBytes : null,
    ...sse,
  };
}
