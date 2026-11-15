export const MODELPRO_VERIFICATION_SCHEMA_VERSION = 1;

export function catalogIdentity({ model, rawModel, selectorKey, label } = {}) {
  const selector = String(selectorKey || '').trim().toLowerCase();
  if (selector === '__picker_a_chat_lock__' || selector === '__picker_b_chat_lock__') {
    return `chat-lock:${selector}:${model || rawModel || String(label || '').trim().toLowerCase()}`;
  }
  if (model) return `model:${model}`;
  if (rawModel) return `raw:${rawModel}`;
  if (selector) return `selector:${selector}`;
  return `label:${String(label || '').trim().toLowerCase()}`;
}

export function verificationChronology(item, normalizeModel = (value) => value || null) {
  const model = normalizeModel(item?.model || item?.rawModel);
  // GPT-5.5 must run before Work/B activation can make it disappear from the picker.
  if (model === 'gpt-5.5') return [-1, 5, 5, ''];
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-(.*))?$/.exec(model || '');
  if (!match) {
    return [1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, model || item?.label || ''];
  }
  return [0, Number(match[1]), Number(match[2] || 0), String(match[3] || '')];
}

export function createVerificationCatalog({
  normalizeModel = (value) => value || null,
  onMerged = null,
  workDiscovery = { attempted: false, entered: false, reason: 'pending_after_gpt_5_5' },
} = {}) {
  const queue = [];
  const knownKeys = new Set();
  const reasoningLevels = new Set();
  const progress = {
    total: 0,
    completed: 0,
    requestConfirmed: 0,
    verified: 0,
    failed: 0,
    currentModel: null,
    currentSelectorKey: null,
    currentLabel: null,
    results: [],
    discoveryPasses: 0,
    stablePasses: 0,
    reasoningLevels: [],
    pickerModes: [],
    workDiscovery: { ...workDiscovery },
  };

  const identity = (item) => catalogIdentity({
    model: normalizeModel(item?.model),
    rawModel: normalizeModel(item?.rawModel),
    selectorKey: item?.selectorKey,
    label: item?.label,
  });

  function sortQueue() {
    const completed = new Set(progress.results.map(identity));
    const pending = queue.filter((item) => !completed.has(identity(item)));
    const done = queue.filter((item) => completed.has(identity(item)));
    pending.sort((left, right) => {
      const a = verificationChronology(left, normalizeModel);
      const b = verificationChronology(right, normalizeModel);
      for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
      }
      return String(a[3]).localeCompare(String(b[3]));
    });
    queue.splice(0, queue.length, ...done, ...pending);
  }

  function merge(catalog, phase = 'unknown') {
    let added = 0;
    if (['A', 'B'].includes(catalog?.pickerMode) && !progress.pickerModes.includes(catalog.pickerMode)) {
      progress.pickerModes.push(catalog.pickerMode);
    }
    for (const level of (catalog?.reasoningLevels || [])) reasoningLevels.add(level);

    for (const row of (Array.isArray(catalog?.rows) ? catalog.rows : [])) {
      const model = normalizeModel(row?.model || row?.rawId);
      const rawModel = normalizeModel(row?.rawId);
      const selectorKey = String(row?.selectorKey || '').trim().slice(0, 200);
      const label = String(row?.label || model || selectorKey || '').trim().slice(0, 160);
      if (!model && !selectorKey && !label) continue;

      const candidate = {
        model,
        rawModel,
        selectorKey,
        label,
        pickerMode: ['A', 'B'].includes(row?.pickerMode) ? row.pickerMode : catalog?.pickerMode || null,
        discoverySource: String(row?.discoverySource || phase || '').trim().slice(0, 80) || null,
        transportModel: row?.transportModel || null,
        expectedResponseModel: row?.expectedResponseModel || null,
        nativeRequestModel: row?.nativeRequestModel || null,
        nativeResponseModel: row?.nativeResponseModel || null,
        nativeResponseConfirmed: row?.nativeResponseConfirmed === true,
      };
      const key = identity(candidate);
      if (knownKeys.has(key)) {
        // A concrete model is the stable identity. A later shared/network candidate
        // must never downgrade a real Picker-A/B locator. Equal-priority locators may
        // still refresh after ChatGPT rebuilds the picker, while a stronger locator
        // (for example Picker A arriving after a server candidate) upgrades in place.
        const existing = queue.find((item) => identity(item) === key);
        if (existing && !progress.results.some((result) => identity(result) === key)) {
          const locatorPriority = (item) => {
            const selector = String(item?.selectorKey || '').trim();
            if (selector && !selector.startsWith('__')) return 30;
            if (selector === '__work_transport__') return 20;
            if (selector === '__network_candidate__') return 10;
            return selector ? 5 : 0;
          };
          const existingPriority = locatorPriority(existing);
          const candidatePriority = locatorPriority(candidate);
          existing.rawModel = rawModel || existing.rawModel;
          existing.transportModel = candidate.transportModel || existing.transportModel;
          existing.expectedResponseModel = candidate.expectedResponseModel || existing.expectedResponseModel;
          existing.nativeRequestModel = candidate.nativeRequestModel || existing.nativeRequestModel;
          existing.nativeResponseModel = candidate.nativeResponseModel || existing.nativeResponseModel;
          existing.nativeResponseConfirmed = candidate.nativeResponseConfirmed || existing.nativeResponseConfirmed;
          if (candidatePriority >= existingPriority) {
            existing.selectorKey = selectorKey || existing.selectorKey;
            existing.label = label || existing.label;
            existing.pickerMode = candidate.pickerMode || existing.pickerMode;
            existing.discoverySource = candidate.discoverySource || existing.discoverySource;
          }
        }
        continue;
      }

      knownKeys.add(key);
      queue.push(candidate);
      added += 1;
    }

    sortQueue();
    progress.total = queue.length;
    progress.reasoningLevels = [...reasoningLevels];
    onMerged?.({
      phase,
      added,
      total: queue.length,
      reasoningLevels: [...progress.reasoningLevels],
      pickerModes: [...progress.pickerModes],
    });
    return added;
  }

  return { queue, knownKeys, reasoningLevels, progress, merge, identity, sortQueue };
}

export function summarizeVerificationOutcome(progress = {}) {
  const total = Number(progress.total || 0);
  const verified = Number(progress.verified || 0);
  const failed = Number(progress.failed || 0);
  const requestConfirmed = Number(progress.requestConfirmed || 0);
  const outcome = total === 0
    ? 'unverified'
    : failed === 0 && verified === total
      ? 'verified'
      : verified > 0
        ? 'partial'
        : 'unverified';
  const reason = total === 0
    ? 'account_model_catalog_empty'
    : failed
      ? requestConfirmed === total
        ? 'response_model_evidence_incomplete'
        : 'account_model_verification_incomplete'
      : null;
  return { outcome, reason, total, verified, failed, requestConfirmed };
}

export function createModelVerificationHistoryRecord(
  tabId,
  autoVerification,
  { reportType = 'modelpro-model-verification-report' } = {},
) {
  const catalog = autoVerification?.catalogVerification && typeof autoVerification.catalogVerification === 'object'
    ? autoVerification.catalogVerification : {};
  const attempts = Array.isArray(autoVerification?.attempts) ? autoVerification.attempts : [];
  const catalogResults = Array.isArray(catalog.results) ? catalog.results : [];
  // The current background autoVerify flow stores per-model attempts but leaves
  // autoVerification.catalogVerification null. Prefer a real catalog when one is
  // supplied, otherwise persist the attempt summaries instead of writing an
  // empty 0-model history record.
  const sourceResults = catalogResults.length ? catalogResults : attempts;
  const total = Number(catalog.total) > 0
    ? Number(catalog.total)
    : Math.max(Number(autoVerification?.maxAttempts || 0), sourceResults.length);
  const verified = Number.isFinite(Number(catalog.verified)) && catalogResults.length
    ? Number(catalog.verified)
    : sourceResults.filter((item) => item?.verified === true || item?.outcome === 'verified').length;
  const requestConfirmed = Number.isFinite(Number(catalog.requestConfirmed)) && catalogResults.length
    ? Number(catalog.requestConfirmed)
    : sourceResults.filter((item) => item?.requestConfirmed === true || item?.requestLockConfirmed === true).length;
  const failed = Number.isFinite(Number(catalog.failed)) && catalogResults.length
    ? Number(catalog.failed)
    : Math.max(0, total - verified);
  const results = sourceResults.map((item) => {
    const identity = item?.responseModelIdentity || item?.modelIdentity || {};
    const responseModelIdentity = identity && typeof identity === 'object' ? {
      status: identity.status ?? null,
      requestedModel: identity.requestedModel ?? null,
      observedModel: identity.observedModel ?? null,
      responseField: identity.responseField ?? null,
      incompleteStream: identity.incompleteStream === true,
      terminalEvent: identity.terminalEvent ?? null,
      networkError: identity.networkError ?? null,
      streamCaptureOverflowed: identity.streamCaptureOverflowed === true,
      variantConfirmed: identity.variantConfirmed === true,
      definitiveMismatch: identity.definitiveMismatch === true,
    } : null;
    return {
      attempt: Number(item?.attempt || 0) || null,
      sent: item?.sent === true || Boolean(item?.requestId),
      model: item?.model ?? null,
      rawModel: item?.rawModel ?? null,
      selectorKey: item?.selectorKey ?? null,
      label: item?.label ?? item?.model ?? item?.requestModel ?? 'Unknown model',
      verified: item?.verified === true || item?.outcome === 'verified',
      requestConfirmed: item?.requestConfirmed === true || item?.requestLockConfirmed === true,
      responseConfirmed: item?.responseConfirmed === true,
      requestId: item?.requestId ?? null,
      responseRequestId: item?.responseRequestId ?? null,
      requestModel: item?.requestModel ?? null,
      rawRequestModel: item?.rawRequestModel ?? null,
      networkObservedRequestModel: item?.networkObservedRequestModel ?? null,
      responseModel: item?.responseModel ?? null,
      rawResponseModel: item?.rawResponseModel ?? item?.nativeResponseModel ?? null,
      responseModelField: item?.responseModelField ?? item?.responseField ?? null,
      responseHttpStatus: item?.responseHttpStatus == null ? null : Number(item.responseHttpStatus),
      evidenceModel: item?.evidenceModel ?? null,
      responseReasoning: item?.responseReasoning ?? null,
      responseVerdict: item?.responseVerdict ?? item?.verdict ?? null,
      responseIssue: item?.responseIssue ?? null,
      evidenceSource: item?.evidenceSource ?? null,
      pickerMode: item?.pickerMode ?? null,
      selectionAttempted: item?.selectionAttempted === true,
      selectionConfirmed: typeof item?.selectionConfirmed === 'boolean' ? item.selectionConfirmed : null,
      nativeStageComplete: typeof item?.nativeStageComplete === 'boolean' ? item.nativeStageComplete : null,
      nativeRequestConfirmed: typeof item?.nativeRequestConfirmed === 'boolean' ? item.nativeRequestConfirmed : null,
      nativeRequestIssue: item?.nativeRequestIssue ?? null,
      nativeRequestModel: item?.nativeRequestModel ?? null,
      nativeResponseObserved: typeof item?.nativeResponseObserved === 'boolean' ? item.nativeResponseObserved : null,
      nativeResponseConfirmed: typeof item?.nativeResponseConfirmed === 'boolean' ? item.nativeResponseConfirmed : null,
      nativeResponseMetadataConfirmed: typeof item?.nativeResponseMetadataConfirmed === 'boolean'
        ? item.nativeResponseMetadataConfirmed : null,
      nativeResponseModel: item?.nativeResponseModel ?? null,
      nativeResponseCompatible: typeof item?.nativeResponseCompatible === 'boolean' ? item.nativeResponseCompatible : null,
      nativeVerificationBasis: item?.nativeVerificationBasis ?? null,
      nativeTransportFailure: item?.nativeTransportFailure ?? null,
      chatLockStageComplete: typeof item?.chatLockStageComplete === 'boolean' ? item.chatLockStageComplete : null,
      chatLockSupported: typeof item?.chatLockSupported === 'boolean' ? item.chatLockSupported : null,
      chatLockRequestConfirmed: typeof item?.chatLockRequestConfirmed === 'boolean' ? item.chatLockRequestConfirmed : null,
      chatLockResponseConfirmed: typeof item?.chatLockResponseConfirmed === 'boolean' ? item.chatLockResponseConfirmed : null,
      chatAttemptTransport: item?.chatAttemptTransport ?? null,
      chatAttemptResponseModel: item?.chatAttemptResponseModel ?? null,
      chatTransportModel: item?.chatTransportModel ?? null,
      chatResponseModel: item?.chatResponseModel ?? null,
      chatAttemptRequestId: item?.chatAttemptRequestId ?? null,
      chatAttemptResponseRequestId: item?.chatAttemptResponseRequestId ?? null,
      chatAttemptResponseIssue: item?.chatAttemptResponseIssue ?? null,
      fourGateEligible: typeof item?.fourGateEligible === 'boolean' ? item.fourGateEligible : null,
      responseModelIdentity,
      timedOut: item?.timedOut === true,
      turnSettled: item?.turnSettled === true,
      outcome: item?.outcome ?? null,
      reason: item?.reason ?? null,
      error: item?.error ?? null,
    };
  });
  const record = {
    id: `${autoVerification?.startedAt || new Date().toISOString()}:${tabId}`,
    tabId,
    sourceTabId: autoVerification?.sourceTabId ?? tabId,
    executionTabId: autoVerification?.executionTabId ?? null,
    startedAt: autoVerification?.startedAt ?? null,
    completedAt: autoVerification?.completedAt ?? null,
    outcome: autoVerification?.outcome ?? 'unverified',
    reason: autoVerification?.reason ?? null,
    total,
    requestConfirmed,
    verified,
    failed,
    resultSource: catalogResults.length ? 'catalog' : attempts.length ? 'attempts' : 'none',
    pageContext: autoVerification?.pageContext ?? null,
    verificationSurface: autoVerification?.verificationSurface ?? null,
    infrastructureFailure: autoVerification?.infrastructureFailure === true,
    pickerModes: Array.isArray(catalog.pickerModes) && catalog.pickerModes.length
      ? [...catalog.pickerModes]
      : [...new Set(results.map((item) => item.pickerMode).filter(Boolean))],
    results,
  };
  record.report = {
    schemaVersion: MODELPRO_VERIFICATION_SCHEMA_VERSION,
    type: reportType,
    generatedAt: record.completedAt || new Date().toISOString(),
    verification: { ...record },
  };
  return record;
}

export function shouldRetryTransientResponse(result = {}, { maxRetries = 1 } = {}) {
  const retryCount = Math.max(0, Number(result.retryCount || 0));
  const httpStatus = Number(result.responseHttpStatus || 0);
  const bodyError = String(result.responseBodyError || result.error || '');
  const responseIssue = String(result.responseIssue || '');
  const commonRetryGate = result.requestConfirmed === true
    && result.responseConfirmed !== true
    && retryCount < Math.max(0, Number(maxRetries || 0))
    && httpStatus === 200;
  if (!commonRetryGate) return false;

  // A model-bearing HTTP 200 response can transiently expose mutually inconsistent
  // served/default routing metadata while the backend handoff settles. Never accept
  // either candidate, but allow one bounded replay before making the whole catalog
  // partial when the next identical request may provide one unambiguous identity.
  if (responseIssue === 'response_metadata_conflict' && !result.responseModel) return true;

  return /(?:net::ERR_ABORTED|network_loading_failed)/i.test(bodyError)
    && (!result.responseModel || responseIssue === 'response_body_read_failed');
}


/**
 * Work picker activation is not request evidence: the exact intercepted request
 * for the captured response must carry the intended official Work model ID.
 * A previous bootstrap/selection request in the same tab is never sufficient.
 * This does not claim the served model when the stream hides its identity.
 */
export function verifyOfficialWorkRequestIdentity({
  expectedModel = null,
  rawRequestModel = null,
  responseRequestId = null,
  requestRequestId = null,
  rewriteRequestId = null,
  normalizeModel = (value) => value || null,
} = {}) {
  const requested = normalizeModel(rawRequestModel);
  const expected = normalizeModel(expectedModel);
  const linked = Boolean(
    responseRequestId && (
      requestRequestId === responseRequestId || rewriteRequestId === responseRequestId
    )
  );
  const confirmed = Boolean(linked && requested && expected && requested === expected);
  const issue = !responseRequestId
    ? 'work_native_response_request_id_missing'
    : !linked
      ? 'work_native_request_id_mismatch'
      : !requested
        ? 'work_native_request_model_missing'
        : requested !== expected
          ? 'work_native_request_model_mismatch'
          : null;
  return { confirmed, issue };
}


/**
 * Server history is an optimization, not an authority for verification status.
 * Reuse Work-native stages ONLY when the server retained an authoritative
 * served-model identity matching the exact intended model. A successful
 * response stream with no raw served-model ID must be re-probed after upgrades.
 */
export function reusableConfirmedWorkNativeStage(prior, model, normalizeModel = (value) => value || null) {
  const target = normalizeModel(model);
  return Boolean(
    target
    && prior?.pickerMode === 'B'
    && prior?.nativeStageComplete === true
    && prior?.requestConfirmed === true
    && prior?.responseConfirmed === true
    && prior?.nativeResponseConfirmed === true
    && prior?.nativeRequestModel
    && normalizeModel(prior.nativeRequestModel) === target
    && prior?.nativeResponseModel
    && normalizeModel(prior.nativeResponseModel) === target
  );
}

/**
 * A definitive negative Chat lock is useful history, not a perpetual skip.
 * Future auto-discovery runs must perform a new, causally observed request.
 * Even historical successes may be reused only with both explicit positive
 * verdicts, the expected raw transport and served response identity.
 */
export function reusableConfirmedChatLockStage(
  prior,
  { pickerMode = null, transportModel = null, expectedResponseModel = null } = {},
  normalizeRawModel = (value) => value || null,
) {
  const transport = normalizeRawModel(transportModel);
  const expected = normalizeRawModel(expectedResponseModel);
  return Boolean(
    ['A', 'B'].includes(pickerMode)
    && prior?.pickerMode === pickerMode
    && prior?.chatLockStageComplete === true
    && prior?.chatLockSupported === true
    && prior?.chatLockRequestConfirmed === true
    && prior?.chatLockResponseConfirmed === true
    && transport
    && expected
    && normalizeRawModel(prior?.chatAttemptTransport) === transport
    && normalizeRawModel(prior?.chatAttemptResponseModel) === expected
  );
}


/**
 * A failed, empty primary conversation body is not evidence of any served model.
 * Terminal HTTP/2 transport failures can stop the passive evidence wait, but an
 * ordinary partial/aborted SSE must NEVER trigger a duplicate probe.
 */
export function terminalOfficialWorkTransportFailure(evidence) {
  const error = String(evidence?.bodyError || '');
  const parsed = Number(evidence?.diagnostics?.parsedObjectCount || 0);
  const bytes = Number(evidence?.diagnostics?.streamCaptureBytes || 0);
  return Boolean(
    /^net::ERR_(?:HTTP2_PROTOCOL_ERROR|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE)$/.test(error)
    && Number(evidence?.diagnostics?.httpStatus || 0) === 200
    && !evidence?.rawModel
    && !evidence?.model
    && !evidence?.conflicts?.model
    && parsed === 0
    && bytes === 0
    && !(typeof evidence?.rawResponseBody === 'string' && evidence.rawResponseBody.length)
  );
}

/**
 * Resending a probe is permitted only after the previous UI turn is confirmed
 * settled, the original model/request IDs matched, and its response terminated
 * with a known empty-body transport failure. Exactly one replay per model/run.
 */
export function shouldRetryOfficialWorkNativeTransport({
  evidence,
  nativeRequestConfirmed = false,
  turnSettled = false,
  requestId = null,
  retryCount = 0,
  maxRetries = 1,
} = {}) {
  return Boolean(
    requestId
    && nativeRequestConfirmed === true
    && turnSettled === true
    && Number(retryCount || 0) < Math.max(0, Number(maxRetries || 0))
    && terminalOfficialWorkTransportFailure(evidence)
  );
}

export function publishableVerificationResults(results = [], normalizeModel = (value) => value || null) {
  return (Array.isArray(results) ? results : []).filter((item) => (
    item?.verified === true
      && item?.requestConfirmed === true
      && item?.responseConfirmed === true
      && Boolean(normalizeModel(item?.model || item?.requestModel))
  ));
}
