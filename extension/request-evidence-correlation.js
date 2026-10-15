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
