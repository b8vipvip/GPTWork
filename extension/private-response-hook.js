import { privateCoreChannel } from './private-core-channel.js';
import { ChatGptNetworkMonitor } from './network-monitor.js';
import { extractStreamHandoff, streamPayloadMatches } from './network-evidence.js';
import {
  buildPrivateResponsePayload,
  decodePrivateResponseBody,
  normalizePrivateResponseEvidence,
} from './private-response-routing.js';

const PATCH_MARKER = Symbol.for('gptlock.privateResponseRouting.v3');

function debuggerCall(method, ...args) {
  return new Promise((resolve, reject) => {
    chrome.debugger[method](...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function safeErrorCode(error, fallback = 'private_response_authority_unavailable') {
  const code = String(error?.code || '').trim();
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code : fallback;
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

function matchingHandoff(monitor, record, body = '') {
  if (!record?.downstream) return null;
  const direct = record.handoffId ? monitor.handoffs.get(record.handoffId) ?? null : null;
  if (direct) return direct;
  const payload = `${record.url || ''}\n${body}`;
  return monitor.matchHandoff(record.tabId, payload) || monitor.newestHandoff(record.tabId);
}

function usableDownstreamResponse(record) {
  const status = Number(record?.status);
  if (Number.isFinite(status) && status >= 400) return false;
  return true;
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

function emitHttpAuthorityFailure(monitor, tabId, params, record, handoff, error) {
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
    model: null,
    reasoning: null,
    conflicts: { model: false, reasoning: false },
    fields: { model: null, reasoning: null },
    bodyError: safeErrorCode(error),
    rawResponseBody: null,
    streamContext,
    diagnostics: {
      endpoint: record.endpoint,
      httpStatus: record.status,
      encodedDataLength: Number.isFinite(params.encodedDataLength) ? params.encodedDataLength : null,
      transport: handoff ? 'sse' : 'http',
      direction: 'received',
      stage: record.downstream ? 'downstream_http' : 'initial_conversation',
      privateEngine: true,
      privateAuthorityAvailable: false,
    },
  });
}

function emitWebSocketAuthorityFailure(monitor, tabId, requestId, handoff, direction, socket, error) {
  const frameId = `ws-${requestId}-${++monitor.webSocketSequence}`;
  const streamContext = monitor.streamContext(handoff, {
    transport: 'websocket',
    direction,
    stage: 'downstream_websocket',
    matchBasis: socket.matchBasis,
  });
  monitor.onEvidence(tabId, {
    requestId: frameId,
    capturedAt: new Date().toISOString(),
    status: 101,
    model: null,
    reasoning: null,
    conflicts: { model: false, reasoning: false },
    fields: { model: null, reasoning: null },
    bodyError: safeErrorCode(error),
    rawResponseBody: null,
    streamContext,
    diagnostics: {
      endpoint: socket.endpoint,
      httpStatus: 101,
      transport: 'websocket',
      direction,
      stage: 'downstream_websocket',
      privateEngine: true,
      privateAuthorityAvailable: false,
    },
  });
}

export function installPrivateResponseRoutingHook() {
  const prototype = ChatGptNetworkMonitor.prototype;
  if (prototype[PATCH_MARKER]) return false;
  const legacyHandleWebSocketFrame = prototype.handleWebSocketFrame;
  if (typeof prototype.handleFinished !== 'function' || typeof legacyHandleWebSocketFrame !== 'function') return false;

  Object.defineProperty(prototype, PATCH_MARKER, { value: true, configurable: false });
  prototype.handleFinished = async function privateHandleFinished(tabId, params = {}) {
    const key = this.key(tabId, String(params.requestId));
    const record = this.requests.get(key);
    if (!record) return;
    if (!record.responseVerificationEnabled) {
      this.requests.delete(key);
      return;
    }
    if (record.downstream && !usableDownstreamResponse(record)) {
      this.requests.delete(key);
      return;
    }
    let handoff = matchingHandoff(this, record);
    if (!(await privateCoreChannel.isAvailable())) {
      this.requests.delete(key);
      emitHttpAuthorityFailure(this, tabId, params, record, handoff, { code: 'private_response_authority_unavailable' });
      return;
    }

    let body = '';
    let evidence;
    try {
      body = await responseBody(this, tabId, record.requestId);
      if (!record.downstream) {
        const parsedHandoff = extractStreamHandoff(body);
        if (parsedHandoff) handoff = this.registerHandoff(tabId, record.requestId, parsedHandoff);
      } else {
        handoff = matchingHandoff(this, record, body);
        if (!handoff) {
          this.requests.delete(key);
          return;
        }
        if (record.downstreamCandidate && !streamPayloadMatches(`${record.url || ''}\n${body}`, handoff)) {
          const age = Date.now() - handoff.startedAt;
          if (age > 12000 || !/event-stream/i.test(record.mimeType || '')) {
            this.requests.delete(key);
            return;
          }
        }
      }
      evidence = await evaluateResponse(
        tabId,
        body,
        record.responseHeaders,
        record.mimeType,
        record.downstream ? 'downstream-http' : 'response',
      );
    } catch (error) {
      privateCoreChannel.invalidate();
      this.requests.delete(key);
      body = '';
      emitHttpAuthorityFailure(this, tabId, params, record, handoff, error);
      return;
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
      emitWebSocketAuthorityFailure(this, tabId, requestId, handoff, direction, socket, { code: 'private_response_authority_unavailable' });
      return;
    }

    let evidence;
    try {
      evidence = await evaluateResponse(tabId, payload, {}, 'application/json', 'websocket');
    } catch (error) {
      privateCoreChannel.invalidate();
      emitWebSocketAuthorityFailure(this, tabId, requestId, handoff, direction, socket, error);
      return;
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
