// This module only correlates observations of one formal request; it never
// decides which model is permitted and never rewrites browser traffic.
const OFFICIAL_ENDPOINTS = new Set(['/backend-api/conversation', '/backend-api/f/conversation']);

export function withForwardedRequestEvidence(request, rewrite) {
  if (!request || !rewrite) return request;
  if (!request.requestId || !rewrite.requestId || request.requestId !== rewrite.requestId) return request;
  if (!rewrite.fetchRequestId || rewrite.error || !OFFICIAL_ENDPOINTS.has(rewrite.endpoint)) return request;
  if (typeof rewrite.modelAfter !== 'string' || !rewrite.modelAfter) return request;
  if (request.forwardedFetchRequestId === rewrite.fetchRequestId
    && request.model === rewrite.modelAfter) return request;

  // The raw Network.requestWillBeSent model is a separate observation, not
  // evidence that Fetch.continueRequest sent it unchanged.
  return {
    ...request,
    // Lock permission belongs to the same Fetch decision as the forwarded
    // transport. Do not silently resnapshot a later page selection in Network.
    policySnapshot: Array.isArray(rewrite.policySnapshot?.lockedModels)
      ? rewrite.policySnapshot
      : request.policySnapshot,
    observedModel: request.observedModel ?? request.model ?? null,
    observedReasoning: request.observedReasoning ?? request.reasoning ?? null,
    model: rewrite.modelAfter,
    reasoning: rewrite.reasoningAfter ?? request.reasoning ?? null,
    forwardedTransportModel: rewrite.transportModelAfter ?? null,
    forwardedFetchRequestId: rewrite.fetchRequestId,
    requestRewritten: Boolean(rewrite.changed),
    requestEvidenceSource: 'fetch_continued',
  };
}

 
// Fetch.requestPaused and Network.requestWillBeSent are asynchronous CDP event
// streams. The page may navigate from / to /c/:id between them, replacing the
// per-conversation tab state. Keep only successful, ID-correlated terminal Fetch
// decisions in a bounded tab/request ledger so Network cannot fall back to a
// stale pre-Fetch body or to an unrelated request's rewrite.
export class ForwardedRequestLedger {
  constructor({ ttlMs = 120_000, maxEntries = 128 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  key(tabId, requestId) {
    return Number.isInteger(Number(tabId)) && requestId
      ? `${Number(tabId)}:${String(requestId)}` : null;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  remember(tabId, rewrite, now = Date.now()) {
    const key = this.key(tabId, rewrite?.requestId);
    if (!key || !rewrite?.fetchRequestId || rewrite.error
      || !OFFICIAL_ENDPOINTS.has(rewrite.endpoint)
      || typeof rewrite.modelAfter !== 'string' || !rewrite.modelAfter) return false;
    this.prune(now);
    this.entries.delete(key);
    this.entries.set(key, { at: now, rewrite });
    this.prune(now);
    return true;
  }

  find(tabId, requestId, now = Date.now()) {
    this.prune(now);
    const key = this.key(tabId, requestId);
    return key ? this.entries.get(key)?.rewrite ?? null : null;
  }

  clearTab(tabId) {
    const prefix = `${Number(tabId)}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}
