(() => {
  const KEY = '__GPTLOCK_MODEL_STATUS_HISTORY__';
  if (globalThis[KEY]) return;

  const SCHEMA_VERSION = 1;
  const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const MODEL_ALIASES = Object.freeze({
    'gpt-5.6-sol-wm': 'gpt-5.6-sol',
    'gpt-5-6': 'gpt-5.6-sol',
  });

  function normalizeModelId(value) {
    const model = String(value ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._:-]{1,128}$/.test(model)) return null;
    return MODEL_ALIASES[model] ?? model;
  }

  function timestamp(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function fresh(entry, nowMs = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
    const capturedAt = timestamp(entry?.capturedAt);
    return Boolean(capturedAt && nowMs - capturedAt >= 0 && nowMs - capturedAt <= maxAgeMs);
  }

  function policyAllows(model, policy) {
    const normalized = normalizeModelId(model);
    if (!normalized) return false;
    const locked = Array.isArray(policy?.lockedModels)
      ? policy.lockedModels.map(normalizeModelId).filter(Boolean)
      : [];
    return !locked.length || locked.includes(normalized);
  }

  function safePrevious(previous) {
    if (!previous || Number(previous.schemaVersion) !== SCHEMA_VERSION) {
      return { schemaVersion: SCHEMA_VERSION, request: null, response: null, updatedAt: null };
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      request: previous.request || null,
      response: previous.response || null,
      updatedAt: previous.updatedAt || null,
    };
  }

  function sourcePriority(source) {
    return source === 'network_request_metadata' || source === 'network_response_metadata' ? 2 : 1;
  }

  function shouldReplaceEvidence(existing, candidate) {
    if (!candidate?.model || !candidate?.capturedAt) return false;
    if (!existing?.model || !existing?.capturedAt) return true;
    const existingAt = timestamp(existing.capturedAt);
    const candidateAt = timestamp(candidate.capturedAt);
    if (candidateAt > existingAt) return true;
    if (candidateAt < existingAt) return false;
    if (normalizeModelId(existing.model) !== normalizeModelId(candidate.model)) return true;
    if (Boolean(candidate.confirmed) !== Boolean(existing.confirmed)) return Boolean(candidate.confirmed);
    return sourcePriority(candidate.source) > sourcePriority(existing.source);
  }

  function sameEvidence(left, right) {
    return normalizeModelId(left?.model) === normalizeModelId(right?.model)
      && String(left?.capturedAt || '') === String(right?.capturedAt || '')
      && String(left?.source || '') === String(right?.source || '')
      && Boolean(left?.confirmed) === Boolean(right?.confirmed);
  }

  function mergeTrustedEvidence(previous, state, nowIso = new Date().toISOString()) {
    const next = safePrevious(previous);
    const auto = state?.autoVerification;
    let changed = false;

    const requestModel = normalizeModelId(state?.lastRequest?.model)
      || (auto?.requestLockConfirmed ? normalizeModelId(auto?.requestModel) : null);
    if (requestModel) {
      const candidate = {
        model: requestModel,
        capturedAt: state?.lastRequest?.capturedAt || auto?.completedAt || state?.updatedAt || nowIso,
        source: state?.lastRequest?.model ? 'network_request_metadata' : 'auto_verification_request',
      };
      if (shouldReplaceEvidence(next.request, candidate) && !sameEvidence(next.request, candidate)) {
        next.request = candidate;
        changed = true;
      }
    }

    const verification = state?.lastVerification;
    const reasons = Array.isArray(verification?.reasons) ? verification.reasons : [];
    const verifiedResponseModel = verification?.evidenceSource === 'network_response_metadata'
      && !reasons.includes('model_missing')
      ? normalizeModelId(verification?.model)
      : null;
    const autoResponseModel = auto?.evidenceSource === 'network_response_metadata'
      && ['verified', 'model_verified_reasoning_unconfirmed'].includes(auto?.outcome)
      ? normalizeModelId(auto?.responseModel)
      : null;
    const responseModel = verifiedResponseModel || autoResponseModel;
    if (responseModel) {
      const candidate = {
        model: responseModel,
        capturedAt: verification?.verifiedAt || auto?.completedAt || state?.updatedAt || nowIso,
        source: verifiedResponseModel ? 'network_response_metadata' : 'auto_verification_response',
        confirmed: true,
      };
      if (shouldReplaceEvidence(next.response, candidate) && !sameEvidence(next.response, candidate)) {
        next.response = candidate;
        changed = true;
      }
    }

    if (changed) next.updatedAt = nowIso;
    return next;
  }

  function responseAppliesToLatestRequest(state) {
    const requestAt = timestamp(state?.lastRequest?.capturedAt);
    const verificationAt = timestamp(state?.lastVerification?.verifiedAt);
    if (!requestAt) return false;
    return Boolean(verificationAt && verificationAt >= requestAt - 1000);
  }

  function selectStatus({ state = null, history = null, policy = null, nowMs = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    const currentRequest = normalizeModelId(state?.lastRequest?.model);
    const verification = state?.lastVerification;
    const currentResponse = responseAppliesToLatestRequest(state)
      ? normalizeModelId(verification?.model)
      : null;
    const responseReasons = Array.isArray(verification?.reasons) ? verification.reasons : [];
    const currentResponseConfirmed = Boolean(
      currentResponse
      && verification?.evidenceSource === 'network_response_metadata'
      && !responseReasons.includes('model_missing')
    );
    const currentResponseMismatch = Boolean(
      currentResponse
      && (responseReasons.includes('model_not_allowed') || verification?.verdict === 'mismatch')
    );

    // Automatic verification clears the current turn before every catalog probe. During
    // that interval the stored trusted history belongs to the previous turn and must not
    // be rendered as if it were the in-flight request/response. The live indicator should
    // say "waiting" until the new probe produces current network evidence.
    const suppressHistory = state?.autoVerification?.running === true;
    const historicalRequest = !suppressHistory && !currentRequest
      && fresh(history?.request, nowMs, maxAgeMs)
      && policyAllows(history?.request?.model, policy)
      ? normalizeModelId(history.request.model)
      : null;
    const historicalResponse = !suppressHistory && !currentRequest
      && fresh(history?.response, nowMs, maxAgeMs)
      && history?.response?.confirmed === true
      && policyAllows(history?.response?.model, policy)
      ? normalizeModelId(history.response.model)
      : null;

    return {
      request: {
        id: currentRequest || historicalRequest,
        current: Boolean(currentRequest),
        historical: Boolean(!currentRequest && historicalRequest),
        source: currentRequest ? 'current-request' : historicalRequest ? 'trusted-history' : 'none',
      },
      response: {
        id: currentResponse || historicalResponse,
        current: Boolean(currentResponse),
        historical: Boolean(!currentResponse && historicalResponse),
        confirmed: currentResponse ? currentResponseConfirmed : Boolean(historicalResponse),
        mismatch: currentResponse ? currentResponseMismatch : false,
        source: currentResponse ? 'current-response' : historicalResponse ? 'trusted-history' : 'none',
      },
    };
  }

  globalThis[KEY] = Object.freeze({
    SCHEMA_VERSION,
    DEFAULT_MAX_AGE_MS,
    normalizeModelId,
    timestamp,
    fresh,
    policyAllows,
    sourcePriority,
    shouldReplaceEvidence,
    sameEvidence,
    mergeTrustedEvidence,
    responseAppliesToLatestRequest,
    selectStatus,
  });
})();
