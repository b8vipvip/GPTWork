const RESPONSE_ACTIVITY_TRANSPORTS = new Set(['http', 'sse', 'websocket']);

export function recordResponseStreamActivity(state, protocol, now = Date.now()) {
  const requestId = String(protocol?.requestId ?? '');
  const timestamp = Number(now);
  if (protocol?.event !== 'conversation_response_activity'
    || !state
    || state.phase !== 'waiting'
    || !requestId
    || String(state.lastRequest?.requestId ?? '') !== requestId
    || !Number.isFinite(timestamp)) {
    return false;
  }

  const tracking = state.streamTracking && typeof state.streamTracking === 'object'
    ? state.streamTracking
    : {
      detectedAt: timestamp,
      lastActivityAt: timestamp,
      downstreamEvidenceCount: 0,
      transports: [],
      handoff: null,
    };
  tracking.lastActivityAt = Math.max(Number(tracking.lastActivityAt) || 0, timestamp);
  if (!Array.isArray(tracking.transports)) tracking.transports = [];
  const transport = RESPONSE_ACTIVITY_TRANSPORTS.has(protocol.transport) ? protocol.transport : null;
  if (transport && !tracking.transports.includes(transport)) tracking.transports.push(transport);
  state.streamTracking = tracking;
  return true;
}
