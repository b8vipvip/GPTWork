const HISTORY_KEY = 'modelVerificationHistoryV1';
const HISTORY_ENABLED_KEY = 'gptworkModelVerificationHistoryEnabled';
const STREAM_CAPTURE_KEY = 'autoVerificationSseCapture';

const asArray = (value) => Array.isArray(value) ? value : [];
const asText = (value) => value == null ? '' : String(value);

function timeValue(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function resultRows(value) {
  const catalog = value?.catalogVerification;
  if (Array.isArray(catalog?.results) && catalog.results.length) return catalog.results;
  if (Array.isArray(value?.results) && value.results.length) return value.results;
  if (Array.isArray(value?.attempts) && value.attempts.length) return value.attempts;
  if (Array.isArray(value?.models)) return value.models;
  return [];
}

function makeSnapshot(value, source, fallbackTime = null) {
  if (!value || typeof value !== 'object') return null;
  const catalog = value.catalogVerification && typeof value.catalogVerification === 'object'
    ? value.catalogVerification : value;
  const completedAt = value.completedAt || value.generatedAt || fallbackTime || null;
  const startedAt = value.startedAt || null;
  const results = resultRows(value);
  if (!completedAt && !startedAt && !results.length && !value.outcome) return null;
  const total = Number(catalog.total ?? value.total ?? value.catalogTotal ?? value.maxAttempts ?? results.length);
  const verifiedCount = results.filter((item) => item?.verified === true || item?.outcome === 'verified').length;
  const requestCount = results.filter((item) => item?.requestConfirmed === true || item?.requestLockConfirmed === true).length;
  return {
    id: asText(value.id || value.startedAt || completedAt || source),
    source,
    startedAt,
    completedAt,
    timestamp: completedAt || startedAt || fallbackTime || '',
    outcome: asText(value.outcome || value.finalOutcome || 'unknown'),
    reason: asText(value.reason || value.finalReason || ''),
    sourceTabId: value.sourceTabId ?? value.tabId ?? null,
    executionTabId: value.executionTabId ?? null,
    total,
    requestConfirmed: Number(catalog.requestConfirmed ?? value.requestConfirmed ?? value.catalogRequestConfirmed ?? requestCount),
    verified: Number(catalog.verified ?? value.verified ?? value.catalogVerified ?? verifiedCount),
    failed: Number(catalog.failed ?? value.failed ?? value.catalogFailed ?? Math.max(0, total - verifiedCount)),
    resultSource: asText(value.resultSource || (Array.isArray(value.attempts) ? 'attempts' : 'catalog')),
    pageContext: asText(value.pageContext),
    pickerModes: asArray(catalog.pickerModes || value.pickerModes),
    results,
  };
}

export function selectLatestVerification({ tabs = [], history = [], runtimeLogs = [] } = {}) {
  const candidates = [];
  for (const tab of asArray(tabs)) {
    const snapshot = makeSnapshot(tab?.autoVerification, 'live-tab');
    if (snapshot) candidates.push(snapshot);
  }
  for (const record of asArray(history)) {
    const snapshot = makeSnapshot(record, 'model-history');
    if (snapshot) candidates.push(snapshot);
  }
  for (const entry of asArray(runtimeLogs)) {
    if (entry?.component !== 'discovery' || entry?.event !== 'auto_verify_completed') continue;
    const snapshot = makeSnapshot(entry.details, 'runtime-log', entry.timestamp);
    if (snapshot) candidates.push(snapshot);
  }
  candidates.sort((left, right) => timeValue(right.timestamp) - timeValue(left.timestamp));
  return candidates[0] || null;
}

function safeModelIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return {
    status: asText(identity.status),
    requestedModel: asText(identity.requestedModel),
    observedModel: asText(identity.observedModel),
    responseField: asText(identity.responseField),
    incompleteStream: identity.incompleteStream === true,
    terminalEvent: asText(identity.terminalEvent),
    networkError: asText(identity.networkError),
    streamCaptureOverflowed: identity.streamCaptureOverflowed === true,
    variantConfirmed: identity.variantConfirmed === true,
    definitiveMismatch: identity.definitiveMismatch === true,
  };
}

export function summarizeModelResult(item = {}) {
  return {
    attempt: item.attempt == null ? null : Number(item.attempt),
    model: asText(item.model || item.label || item.rawModel || 'unknown'),
    pickerMode: asText(item.pickerMode),
    selectionAttempted: item.selectionAttempted === true,
    selectionConfirmed: typeof item.selectionConfirmed === 'boolean' ? item.selectionConfirmed : null,
    nativeStageComplete: typeof item.nativeStageComplete === 'boolean' ? item.nativeStageComplete : null,
    nativeRequestConfirmed: typeof item.nativeRequestConfirmed === 'boolean' ? item.nativeRequestConfirmed : null,
    nativeRequestIssue: asText(item.nativeRequestIssue),
    nativeRequestModel: asText(item.nativeRequestModel),
    nativeResponseObserved: typeof item.nativeResponseObserved === 'boolean' ? item.nativeResponseObserved : null,
    nativeResponseConfirmed: typeof item.nativeResponseConfirmed === 'boolean' ? item.nativeResponseConfirmed : null,
    nativeResponseMetadataConfirmed: typeof item.nativeResponseMetadataConfirmed === 'boolean'
      ? item.nativeResponseMetadataConfirmed : null,
    nativeResponseModel: asText(item.nativeResponseModel),
    nativeResponseCompatible: typeof item.nativeResponseCompatible === 'boolean' ? item.nativeResponseCompatible : null,
    nativeVerificationBasis: asText(item.nativeVerificationBasis),
    nativeTransportFailure: asText(item.nativeTransportFailure),
    requestConfirmed: item.requestConfirmed === true || item.requestLockConfirmed === true,
    requestModel: asText(item.requestModel),
    rawRequestModel: asText(item.rawRequestModel),
    networkObservedRequestModel: asText(item.networkObservedRequestModel),
    responseConfirmed: item.responseConfirmed === true,
    responseModel: asText(item.responseModel),
    rawResponseModel: asText(item.rawResponseModel || item.nativeResponseModel),
    responseModelField: asText(item.responseModelField || item.responseField),
    responseRequestId: asText(item.responseRequestId),
    requestId: asText(item.requestId),
    responseIssue: asText(item.responseIssue),
    responseHttpStatus: item.responseHttpStatus == null ? null : Number(item.responseHttpStatus),
    evidenceSource: asText(item.evidenceSource),
    responseVerdict: asText(item.responseVerdict || item.verdict),
    chatLockStageComplete: typeof item.chatLockStageComplete === 'boolean' ? item.chatLockStageComplete : null,
    chatLockSupported: typeof item.chatLockSupported === 'boolean' ? item.chatLockSupported : null,
    chatLockRequestConfirmed: typeof item.chatLockRequestConfirmed === 'boolean' ? item.chatLockRequestConfirmed : null,
    chatLockResponseConfirmed: typeof item.chatLockResponseConfirmed === 'boolean' ? item.chatLockResponseConfirmed : null,
    chatAttemptTransport: asText(item.chatAttemptTransport),
    chatAttemptResponseModel: asText(item.chatAttemptResponseModel),
    chatTransportModel: asText(item.chatTransportModel),
    chatResponseModel: asText(item.chatResponseModel),
    chatAttemptRequestId: asText(item.chatAttemptRequestId),
    chatAttemptResponseRequestId: asText(item.chatAttemptResponseRequestId),
    chatAttemptResponseIssue: asText(item.chatAttemptResponseIssue),
    fourGateEligible: typeof item.fourGateEligible === 'boolean' ? item.fourGateEligible : null,
    responseModelIdentity: safeModelIdentity(item.responseModelIdentity || item.modelIdentity),
    timedOut: item.timedOut === true,
    turnSettled: item.turnSettled === true,
    verified: item.verified === true || item.outcome === 'verified',
    error: asText(item.error || item.reason),
  };
}

function withinVerificationWindow(entry, snapshot) {
  const timestamp = timeValue(entry?.timestamp);
  const start = timeValue(snapshot?.startedAt);
  const end = timeValue(snapshot?.completedAt);
  if (start && timestamp && timestamp < start - 15000) return false;
  if (end && timestamp && timestamp > end + 15000) return false;
  const expectedTab = snapshot?.executionTabId;
  const actualTab = entry?.details?.tabId;
  if (expectedTab != null && actualTab != null && Number(expectedTab) !== Number(actualTab)) return false;
  return true;
}

function intersectsModel(values, item) {
  const wanted = new Set([item?.model, item?.requestModel, item?.rawModel]
    .map((value) => asText(value).trim().toLowerCase()).filter(Boolean));
  return values.some((value) => wanted.has(asText(value).trim().toLowerCase()));
}

export function enrichVerificationSnapshot(snapshot, runtimeLogs = []) {
  if (!snapshot) return null;
  const logs = asArray(runtimeLogs);
  const results = snapshot.results.map((sourceItem) => {
    const item = summarizeModelResult(sourceItem);
    const relevant = logs.filter((entry) => withinVerificationWindow(entry, snapshot));
    const requestEvents = relevant.filter((entry) => entry?.event === 'formal_conversation_request_detected'
      && intersectsModel([
        entry?.details?.model,
        entry?.details?.observedModel,
        entry?.details?.forwardedModel,
      ], item));
    const requestEvent = requestEvents.sort((a, b) => timeValue(b.timestamp) - timeValue(a.timestamp))[0] || null;
    const requestId = item.requestId || asText(requestEvent?.details?.requestId);
    const responseEvents = relevant.filter((entry) => [
      'response_evaluated',
      'conversation_response_metadata_observed',
    ].includes(entry?.event));
    const responseEvent = responseEvents
      .filter((entry) => {
        const detailId = asText(entry?.details?.requestId || entry?.details?.transportRequestId);
        if (requestId && detailId) return detailId === requestId;
        return intersectsModel([
          entry?.details?.requestModel,
          entry?.details?.modelIdentity?.requestedModel,
          entry?.details?.rawResponseModel,
          entry?.details?.originalResponseModel,
          entry?.details?.observedModel,
        ], item);
      })
      .sort((a, b) => {
        const aExact = requestId && asText(a?.details?.requestId || a?.details?.transportRequestId) === requestId ? 1 : 0;
        const bExact = requestId && asText(b?.details?.requestId || b?.details?.transportRequestId) === requestId ? 1 : 0;
        return bExact - aExact || timeValue(b.timestamp) - timeValue(a.timestamp);
      })[0] || null;
    const requestDetails = requestEvent?.details || {};
    const responseDetails = responseEvent?.details || {};
    const identity = responseDetails.modelIdentity || {};
    const diagnostics = responseDetails.diagnostics || {};
    return {
      ...item,
      requestId: item.requestId || requestId,
      responseRequestId: item.responseRequestId || asText(responseDetails.requestId || responseDetails.transportRequestId),
      rawRequestModel: item.rawRequestModel
        || asText(requestDetails.observedModel || requestDetails.forwardedModel || requestDetails.model),
      rawResponseModel: item.rawResponseModel
        || asText(responseDetails.rawResponseModel || responseDetails.originalResponseModel || responseDetails.observedModel),
      responseModel: item.responseModel || asText(responseDetails.model || responseDetails.originalResponseModel),
      responseModelField: item.responseModelField || asText(responseDetails.responseModelField || identity.responseField),
      responseHttpStatus: item.responseHttpStatus ?? (diagnostics.httpStatus == null
        ? responseDetails.httpStatus == null ? null : Number(responseDetails.httpStatus)
        : Number(diagnostics.httpStatus)),
      responseIssue: item.responseIssue || asText(responseDetails.evidenceIssue),
      evidenceSource: item.evidenceSource || asText(responseDetails.evidenceSource),
      responseVerdict: item.responseVerdict || asText(responseDetails.verdict),
      responseModelIdentity: item.responseModelIdentity || safeModelIdentity(identity),
      requestEvidenceSource: asText(requestDetails.requestEvidenceSource),
    };
  });
  return { ...snapshot, results };
}

export function latestGatePublication(runtimeLogs = []) {
  const entry = asArray(runtimeLogs).filter((item) => item?.component === 'discovery'
    && item?.event === 'shared_model_catalog_published')
    .sort((a, b) => timeValue(b.timestamp) - timeValue(a.timestamp))[0];
  if (!entry) return null;
  const details = entry.details || {};
  return {
    timestamp: asText(entry.timestamp),
    submitted: Number(details.submitted || 0),
    nativeResponseConfirmed: Number(details.nativeResponseConfirmed || 0),
    workNativeResponseObserved: Number(details.workNativeResponseObserved || 0),
    workNativeResponseMetadataConfirmed: Number(details.workNativeResponseMetadataConfirmed || 0),
    chatLockSupported: Number(details.chatLockSupported || 0),
    fourGateEligible: Number(details.fourGateEligible || 0),
    shared: Number(details.shared || 0),
    generation: Number(details.generation || 0),
  };
}

export function summarizeStreamCapture(capture) {
  const entries = asArray(capture?.entries).map((entry) => ({
    attempt: entry?.attempt ?? null,
    requestId: asText(entry?.requestId),
    capturedAt: asText(entry?.capturedAt),
    endpoint: asText(entry?.endpoint),
    httpStatus: entry?.httpStatus == null ? null : Number(entry.httpStatus),
    mimeType: asText(entry?.mimeType),
    bodyFormat: asText(entry?.bodyFormat),
    transport: asText(entry?.transport),
    direction: asText(entry?.direction),
    stage: asText(entry?.stage),
    requestModel: asText(entry?.requestModel),
    bodyBytes: Number(entry?.bodyBytes || 0),
  }));
  const omitted = asArray(capture?.omitted).map((entry) => ({
    attempt: entry?.attempt ?? null,
    requestId: asText(entry?.requestId),
    capturedAt: asText(entry?.capturedAt),
    httpStatus: entry?.httpStatus == null ? null : Number(entry.httpStatus),
    transport: asText(entry?.transport),
    direction: asText(entry?.direction),
    stage: asText(entry?.stage),
    bodyBytes: Number(entry?.bodyBytes || 0),
    reason: asText(entry?.reason),
  }));
  return {
    available: Boolean(capture && typeof capture === 'object'),
    schemaVersion: Number(capture?.schemaVersion || 0),
    captureScope: asText(capture?.captureScope),
    tabId: capture?.tabId ?? null,
    startedAt: asText(capture?.startedAt),
    completedAt: asText(capture?.completedAt),
    totalBytes: Number(capture?.totalBytes || 0),
    includedBytes: Number(capture?.includedBytes || 0),
    maxBytes: Number(capture?.maxBytes || 0),
    overflowed: capture?.overflowed === true,
    omittedResponses: Number(capture?.omittedResponses || 0),
    omittedBytes: Number(capture?.omittedBytes || 0),
    entries,
    omitted,
  };
}

function safeRuntimeEvent(entry) {
  const details = entry?.details && typeof entry.details === 'object' ? entry.details : {};
  const allowed = [
    'tabId', 'sourceTabId', 'executionTabId', 'outcome', 'reason',
    'catalogTotal', 'catalogRequestConfirmed', 'catalogVerified', 'catalogFailed',
    'requestId', 'responseRequestId', 'requestModel', 'rawRequestModel',
    'networkObservedRequestModel', 'responseModel', 'rawResponseModel',
    'responseIssue', 'responseHttpStatus', 'pickerMode', 'model',
    'streamCaptureBytes', 'streamCaptureOverflowed',
    'observedModel', 'forwardedModel', 'originalResponseModel', 'responseModelField',
    'responseVerdict', 'verdict', 'decision', 'responseHttpStatus', 'httpStatus',
    'nativeResponseConfirmed', 'workNativeResponseObserved',
    'workNativeResponseMetadataConfirmed', 'chatLockSupported',
    'fourGateEligible', 'shared', 'submitted', 'generation',
  ];
  const selected = {};
  for (const key of allowed) {
    if (Object.hasOwn(details, key)) selected[key] = details[key];
  }
  if (Array.isArray(details.models)) selected.models = details.models.map(summarizeModelResult);
  if (details.modelIdentity && typeof details.modelIdentity === 'object') {
    selected.modelIdentity = safeModelIdentity(details.modelIdentity);
  }
  return {
    timestamp: asText(entry?.timestamp),
    level: asText(entry?.level),
    component: asText(entry?.component),
    event: asText(entry?.event),
    details: selected,
  };
}

export function createDiagnosticsReport({
  bundle = {},
  runtimeLogs = [],
  history = [],
  historyEnabled = false,
  streamCapture = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const logs = asArray(runtimeLogs);
  const selected = selectLatestVerification({
    tabs: asArray(bundle.tabs),
    history: historyEnabled === true ? asArray(history) : [],
    runtimeLogs: logs,
  });
  const latest = enrichVerificationSnapshot(selected, logs);
  const stream = summarizeStreamCapture(streamCapture || bundle.autoVerificationStream);
  const gatePublication = latestGatePublication(logs);
  return {
    schemaVersion: 1,
    type: 'gptwork-diagnostics-summary',
    generatedAt,
    extension: {
      version: asText(bundle.extension?.version),
      platform: asText(bundle.extension?.platform),
    },
    nativeStatus: {
      connected: bundle.nativeStatus?.connected === true,
      error: asText(bundle.nativeDiagnosticsError || bundle.nativeStatus?.error),
      auditRecordCount: asArray(bundle.nativeDiagnostics?.auditRecords).length,
    },
    modelVerification: {
      historyEnabled: historyEnabled === true,
      historyCount: historyEnabled === true ? asArray(history).length : null,
      latest,
      history: historyEnabled === true
        ? asArray(history).slice(0, 50).map((record) => {
          const snapshot = makeSnapshot(record, 'model-history');
          return snapshot ? enrichVerificationSnapshot(snapshot, logs) : null;
        }).filter(Boolean)
        : [],
    },
    fourGatePublication: gatePublication,
    runtimeEvents: logs
      .filter((entry) => entry?.component === 'discovery'
        || /model|verification|response/i.test(String(entry?.component || '')))
      .slice(-100)
      .map(safeRuntimeEvent),
    streamCapture: stream,
    privacy: {
      rawSseIncluded: false,
      rawWebSocketFramesIncluded: false,
      responseBodiesIncluded: false,
      requestBodiesIncluded: false,
      note: 'Stream payloads are intentionally excluded; only request correlation and transport metadata are retained.',
    },
  };
}

export const DIAGNOSTICS_STORAGE_KEYS = Object.freeze({
  history: HISTORY_KEY,
  historyEnabled: HISTORY_ENABLED_KEY,
  streamCapture: STREAM_CAPTURE_KEY,
});
