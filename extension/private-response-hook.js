import { privateCoreChannel } from './private-core-channel.js';
import { ChatGptNetworkMonitor } from './network-monitor.js';
import {
  buildPrivateResponsePayload,
  decodePrivateResponseBody,
  hasCompletePrivateResponseEvidence,
  normalizePrivateResponseEvidence,
} from './private-response-routing.js';

const PATCH_MARKER = Symbol.for('gptlock.privateResponseRouting.v2');

function debuggerCall(method, ...args) {
  return new Promise((resolve, reject) => {
    chrome.debugger[method](...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function responseBody(monitor, tabId, requestId) {
  const result = await debuggerCall(
    'sendCommand',
    monitor.target(tabId),
    'Network.getResponseBody',
    { requestId },
  );
  return decodePrivateResponseBody(result?.body ?? '', Boolean(result?.base64Encoded));
}

async function evaluateResponse(tabId, body, headers, mimeType, prefix) {
  const windowKey = await privateCoreChannel.windowKeyForTab(tabId);
  const rawEvidence = await privateCoreChannel.request(
    'evaluate_response',
    buildPrivateResponsePayload({ body, headers, mimeType }),
    prefix,
    { windowKey },
  );
  return normalizePrivateResponseEvidence(rawEvidence);
}

function matchingHandoff(monitor, record) {
  if (!record?.downstream || !record.handoffId) return null;
  return monitor.handoffs.get(record.handoffId) ?? null;
}

function emitHttpEvidence(monitor, tabId, params, record, evidence, body, handoff) {
  const bodyFormat = String(evidence.diagnostics?.bodyFormat || '');
  const keepRawForExplicitDiagnostics = /event-stream/i.test(record.mimeType || '') || bodyFormat.includes('sse');
  const streamContext = handoff
    ? monitor.streamContext(handoff, {
      isDownstream: true,
      transport: 'sse',
      direction: 'received',
      stage: 'downstream_http',
      matchBasis: record.matchBasis ?? 'handoff_marker',
    })
    : null;
  monitor.onEvidence(tabId, {
    requestId: record.requestId,
    capturedAt: new Date().toISOString(),
    status: record.status,
    model: evidence.model,
    reasoning: evidence.reasoning,
    conflicts: evidence.conflicts,
    fields: evidence.fields,
    bodyError: null,
    rawResponseBody: keepRawForExplicitDiagnostics ? body : null,
    streamContext,
    diagnostics: {
      endpoint: record.endpoint,
      httpStatus: record.status,
      encodedDataLength: Number.isFinite(params.encodedDataLength) ? params.encodedDataLength : null,
      transport: 'sse',
      direction: 'received',
      stage: record.downstream ? 'downstream_http' : 'initial_conversation',
      streamHandoff: null,
      privateEngine: true,
      ...evidence.diagnostics,
    },
  });
}

export function installPrivateResponseRoutingHook() {
  const prototype = ChatGptNetworkMonitor.prototype;
  if (prototype[PATCH_MARKER]) return false;
  const legacyHandleFinished = prototype.handleFinished;
  const legacyHandleWebSocketFrame = prototype.handleWebSocketFrame;
  if (typeof legacyHandleFinished !== 'function' || typeof legacyHandleWebSocketFrame !== 'function') return false;

  Object.defineProperty(prototype, PATCH_MARKER, { value: true, configurable: false });
  prototype.handleFinished = async function privateHandleFinished(tabId, params = {}) {
    const key = this.key(tabId, String(params.requestId));
    const record = this.requests.get(key);
    if (!record || !record.responseVerificationEnabled) {
      return legacyHandleFinished.call(this, tabId, params);
    }
    const handoff = matchingHandoff(this, record);
    if (record.downstream && !handoff) {
      return legacyHandleFinished.call(this, tabId, params);
    }
    if (!(await privateCoreChannel.isAvailable())) {
      return legacyHandleFinished.call(this, tabId, params);
    }

    let body = '';
    let evidence;
    try {
      body = await responseBody(this, tabId, record.requestId);
      evidence = await evaluateResponse(
        tabId,
        body,
        record.responseHeaders,
        record.mimeType,
        record.downstream ? 'downstream-http' : 'response',
      );
    } catch {
      privateCoreChannel.invalidate();
      body = '';
      return legacyHandleFinished.call(this, tabId, params);
    }

    if (!hasCompletePrivateResponseEvidence(evidence)) {
      body = '';
      return legacyHandleFinished.call(this, tabId, params);
    }

    this.requests.delete(key);
    emitHttpEvidence(this, tabId, params, record, evidence, body, handoff);
    body = '';
  };

  prototype.handleWebSocketFrame = async function privateHandleWebSocketFrame(tabId, params = {}, direction) {
    const payload = typeof params.response?.payloadData === 'string' ? params.response.payloadData : '';
    const handoff = this.matchHandoff(tabId, payload);
    if (!handoff) return legacyHandleWebSocketFrame.call(this, tabId, params, direction);

    const requestId = String(params.requestId);
    const key = this.key(tabId, requestId);
    let socket = this.webSockets.get(key);
    if (!socket) {
      socket = {
        tabId,
        requestId,
        url: '',
        endpoint: 'websocket',
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        handoffId: null,
        matchedAt: null,
        matchBasis: null,
      };
      this.webSockets.set(key, socket);
    }
    socket.lastActivityAt = Date.now();
    socket.handoffId = handoff.id;
    socket.matchedAt = Date.now();
    socket.matchBasis = direction === 'sent' ? 'subscription_frame_marker' : 'received_frame_marker';
    if (direction === 'sent') return;

    if (!(await privateCoreChannel.isAvailable())) {
      return legacyHandleWebSocketFrame.call(this, tabId, params, direction);
    }

    let evidence;
    try {
      evidence = await evaluateResponse(tabId, payload, {}, 'application/json', 'websocket');
    } catch {
      privateCoreChannel.invalidate();
      return legacyHandleWebSocketFrame.call(this, tabId, params, direction);
    }
    if (!hasCompletePrivateResponseEvidence(evidence)) {
      return legacyHandleWebSocketFrame.call(this, tabId, params, direction);
    }

    const frameId = `ws-${requestId}-${++this.webSocketSequence}`;
    const streamContext = this.streamContext(handoff, {
      transport: 'websocket',
      direction,
      stage: 'downstream_websocket',
      matchBasis: socket.matchBasis,
    });
    this.onEvidence(tabId, {
      requestId: frameId,
      capturedAt: new Date().toISOString(),
      status: 101,
      model: evidence.model,
      reasoning: evidence.reasoning,
      conflicts: evidence.conflicts,
      fields: evidence.fields,
      bodyError: null,
      rawResponseBody: payload,
      streamContext,
      diagnostics: {
        endpoint: socket.endpoint,
        httpStatus: 101,
        transport: 'websocket',
        direction,
        stage: 'downstream_websocket',
        privateEngine: true,
        ...evidence.diagnostics,
      },
    });
  };
  return true;
}

installPrivateResponseRoutingHook();
