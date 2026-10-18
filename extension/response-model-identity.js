import { normalizeConcreteModelId } from './policy.js';

// This classifies the precision of *observed evidence*, not the actual backend
// routing. A base slug such as "gpt-6" cannot prove or disprove Astra/Sol.
export function classifyResponseModelIdentity({
  requestModel = null,
  responseModel = null,
  responseField = null,
  modelConflict = false,
  terminalEvent = null,
  networkError = null,
  streamCaptureOverflowed = false,
} = {}) {
  const requested = normalizeConcreteModelId(requestModel);
  const observed = normalizeConcreteModelId(responseModel);
  const incompleteStream = terminalEvent === 'loadingFailed'
    || Boolean(networkError)
    || streamCaptureOverflowed === true;
  let status = 'missing';
  if (modelConflict) status = 'metadata_conflict';
  else if (!observed) status = 'missing';
  else if (!requested) status = 'unpaired';
  else if (requested === observed) status = 'exact';
  else {
    const requestedVariant = /^(gpt-\d+(?:\.\d+)*)(?:-([a-z][a-z0-9-]*))$/.exec(requested);
    const familyOnly = requestedVariant && observed === requestedVariant[1];
    if (familyOnly) status = 'family_only';
    else status = incompleteStream ? 'provisional_difference' : 'different';
  }
  return {
    status,
    requestedModel: requested,
    observedModel: observed,
    responseField: typeof responseField === 'string' ? responseField.slice(0, 160) : null,
    incompleteStream,
    terminalEvent: terminalEvent || null,
    networkError: networkError || null,
    streamCaptureOverflowed: streamCaptureOverflowed === true,
    // No confirmation or hard mismatch may be inferred from a family-only
    // identifier, an incomplete stream, or uncorrelated metadata.
    variantConfirmed: status === 'exact',
    definitiveMismatch: status === 'different',
  };
}
