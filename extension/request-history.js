export const REQUEST_HISTORY_LIMIT = 100;

function safeTabId(value) {
  return Number.isInteger(value) ? value : null;
}

function requestKey(tabId, requestId) {
  if (tabId === null || requestId === null || requestId === undefined || requestId === '') return null;
  return `${tabId}:${String(requestId)}`;
}

function isoTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function eventDetails(entry) {
  return entry?.details && typeof entry.details === 'object' ? entry.details : {};
}

function finalizePending(record) {
  if (!record || record.status !== 'waiting') return;
  record.status = 'unconfirmed';
  record.statusReason = 'next_request_started_before_response_confirmation';
}

/**
 * Build a read-only request model history from the authoritative runtime evidence log.
 *
 * This module never participates in locking, verification, routing or blocking. It only
 * projects existing lock/request/response events into rows for the settings UI.
 */
export function buildRequestModelHistory(entries, { limit = REQUEST_HISTORY_LIMIT } = {}) {
  const logs = Array.isArray(entries) ? entries : [];
  const records = [];
  const pendingRewriteByRequest = new Map();
  const pendingRewriteByTab = new Map();
  const activeRecordByRequest = new Map();
  const activeRecordByTab = new Map();

  for (const entry of logs) {
    const details = eventDetails(entry);
    const tabId = safeTabId(details.tabId);
    if (tabId === null) continue;

    if (
      entry?.component === 'lock'
      && (entry?.event === 'request_lock_rewritten' || entry?.event === 'request_lock_checked')
    ) {
      const rewrite = {
        requestId: details.requestId ?? null,
        timestamp: isoTimestamp(entry.timestamp),
        changed: Boolean(details.changed),
        reason: details.reason ?? null,
        modelBefore: details.modelBefore ?? null,
        modelAfter: details.modelAfter ?? null,
        transportModelBefore: details.transportModelBefore ?? null,
        transportModelAfter: details.transportModelAfter ?? null,
        reasoningBefore: details.reasoningBefore ?? null,
        reasoningAfter: details.reasoningAfter ?? null,
      };
      const key = requestKey(tabId, rewrite.requestId);
      if (key) pendingRewriteByRequest.set(key, rewrite);
      pendingRewriteByTab.set(tabId, rewrite);
      continue;
    }

    if (entry?.component === 'network' && entry?.event === 'formal_conversation_request_detected') {
      const requestId = details.requestId ?? null;
      const key = requestKey(tabId, requestId);
      const previous = activeRecordByTab.get(tabId);
      finalizePending(previous);

      const rewrite = (key ? pendingRewriteByRequest.get(key) : null) ?? pendingRewriteByTab.get(tabId) ?? null;
      if (key) pendingRewriteByRequest.delete(key);
      if (pendingRewriteByTab.get(tabId) === rewrite) pendingRewriteByTab.delete(tabId);
      const requestModel = details.model ?? null;
      const discoveredModel = rewrite?.modelBefore ?? requestModel;
      const record = {
        id: typeof entry.id === 'string' && entry.id ? entry.id : `request:${tabId}:${entry.timestamp ?? records.length}`,
        tabId,
        requestId,
        capturedAt: isoTimestamp(entry.timestamp),
        discoveredModel,
        discoveredTransportModel: rewrite?.transportModelBefore ?? null,
        requestModel,
        requestTransportModel: rewrite?.transportModelAfter ?? null,
        finalModel: null,
        requestReasoning: details.reasoning ?? rewrite?.reasoningAfter ?? null,
        finalReasoning: null,
        rewriteChanged: Boolean(rewrite?.changed),
        rewriteReason: rewrite?.reason ?? null,
        status: details.responseVerificationEnabled === false ? 'request_only' : 'waiting',
        statusReason: details.responseVerificationEnabled === false ? 'response_verification_disabled' : null,
        evidenceSource: 'formal_request_post',
        completedAt: null,
      };
      records.push(record);
      if (key) activeRecordByRequest.set(key, record);
      activeRecordByTab.set(tabId, record);
      continue;
    }

    if (entry?.component === 'verification' && entry?.event === 'response_evaluated') {
      const key = requestKey(tabId, details.requestId ?? null);
      const record = (key ? activeRecordByRequest.get(key) : null) ?? activeRecordByTab.get(tabId);
      if (!record) continue;
      record.finalModel = details.model ?? record.finalModel;
      record.finalReasoning = details.reasoning ?? record.finalReasoning;
      record.status = details.verdict ?? 'unverified';
      record.statusReason = details.reason ?? details.evidenceIssue ?? null;
      record.evidenceSource = details.evidenceSource ?? 'network_response_metadata';
      record.completedAt = isoTimestamp(entry.timestamp);
      continue;
    }

    if (entry?.component === 'verification' && entry?.event === 'response_evaluation_failed') {
      const key = requestKey(tabId, details.requestId ?? null);
      const record = (key ? activeRecordByRequest.get(key) : null) ?? activeRecordByTab.get(tabId);
      if (!record) continue;
      record.status = 'error';
      record.statusReason = details.error ?? 'response_evaluation_failed';
      record.completedAt = isoTimestamp(entry.timestamp);
    }
  }

  const boundedLimit = Math.max(1, Number(limit) || REQUEST_HISTORY_LIMIT);
  return records.slice(-boundedLimit).reverse();
}
