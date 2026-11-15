const HISTORY_KEY = 'modelVerificationHistoryV1';
const HISTORY_ENABLED_KEY = 'gptworkModelVerificationHistoryEnabled';
const STREAM_CAPTURE_KEY = 'autoVerificationSseCapture';

const asArray = (value) => Array.isArray(value) ? value : [];
const asText = (value) => value == null ? '' : String(value);

function timeValue(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function makeSnapshot(value, source, fallbackTime = null) {
  if (!value || typeof value !== 'object') return null;
  const catalog = value.catalogVerification && typeof value.catalogVerification === 'object'
    ? value.catalogVerification : value;
  const completedAt = value.completedAt || value.generatedAt || fallbackTime || null;
  const startedAt = value.startedAt || null;
  const catalogResults = asArray(catalog.results);
  const savedResults = asArray(value.results);
  const attempts = asArray(value.attempts);
  const models = asArray(value.models);
  const results = catalogResults.length ? catalogResults : savedResults.length ? savedResults
    : attempts.length ? attempts : models;
  const resultSource = catalogResults.length || savedResults.length ? 'catalog'
    : attempts.length ? 'attempts' : models.length ? 'runtime-log' : 'none';
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
    failed: Number(catalog.failed ?? value.failed ?? value.catalogFailed ?? Math.max(0, results.length - verifiedCount)),
    resultSource: asText(value.resultSource || resultSource),
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
  // The catalog completion event retains per-probe IDs and stage evidence.
  // Pair it with the final summary from the same isolated execution tab.
  const discoveryByTab = new Map();
  const orderedLogs = asArray(runtimeLogs).slice().sort((a, b) => timeValue(a?.timestamp) - timeValue(b?.timestamp));
  for (const entry of orderedLogs) {
    if (entry?.component !== 'discovery') continue;
    const details = entry.details || {};
    if (entry.event === 'model_discovery_started' && Number.isInteger(details.tabId)) {
      discoveryByTab.set(details.tabId, { startedAt: entry.timestamp });
    }
    if (entry.event === 'model_discovery_completed' && Number.isInteger(details.tabId)) {
      discoveryByTab.set(details.tabId, { ...discoveryByTab.get(details.tabId), catalog: details });
    }
    if (!['auto_verify_completed', 'auto_verify_infrastructure_failed'].includes(entry.event)) continue;
    const discovery = discoveryByTab.get(details.executionTabId);
    discoveryByTab.delete(details.executionTabId);
    const snapshot = makeSnapshot({
      ...details,
      startedAt: details.startedAt ?? discovery?.startedAt,
      outcome: details.outcome ?? 'unverified',
      catalogVerification: entry.event === 'auto_verify_completed' ? discovery?.catalog : null,
    }, 'runtime-log', entry.timestamp);
    if (snapshot) candidates.push(snapshot);
  }
  candidates.sort((left, right) => timeValue(right.timestamp) - timeValue(left.timestamp));
  return candidates[0] || null;
}

function safeModelIdentity(identity) {
  if (!identity || typeof identity !== 'object' || !Object.keys(identity).length) return null;
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
    model: asText(item.model || item.label || item.rawModel || item.requestModel || 'unknown'),
    selectorKey: asText(item.selectorKey),
    discoverySource: asText(item.discoverySource),
    pickerMode: asText(item.pickerMode),
    selectionAttempted: item.selectionAttempted ?? item.selected ?? null,
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
    requestConfirmed: item.requestConfirmed ?? item.requestLockConfirmed ?? null,
    requestModel: asText(item.requestModel),
    rawRequestModel: asText(item.rawRequestModel),
    networkObservedRequestModel: asText(item.networkObservedRequestModel),
    responseConfirmed: item.responseConfirmed ?? null,
    responseModel: asText(item.responseModel),
    rawResponseModel: asText(item.rawResponseModel),
    responseModelField: asText(item.responseModelField || item.responseField),
    responseRequestId: asText(item.responseRequestId),
    requestId: asText(item.requestId),
    responseIssue: asText(item.responseIssue),
    responseHttpStatus: Number(item.responseHttpStatus) || null,
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

export function enrichVerificationSnapshot(snapshot, runtimeLogs = []) {
  if (!snapshot) return null;
  const requests = new Map();
  const responses = new Map();
  const evaluations = new Map();
  const start = timeValue(snapshot.startedAt);
  const end = timeValue(snapshot.completedAt);
  const orderedLogs = asArray(runtimeLogs).slice().sort((a, b) => timeValue(a?.timestamp) - timeValue(b?.timestamp));
  for (const entry of orderedLogs) {
    const details = entry?.details;
    const timestamp = timeValue(entry?.timestamp);
    if (snapshot.executionTabId == null || details?.tabId !== snapshot.executionTabId
      || !details.requestId || !start || !timestamp || timestamp < start || (end && timestamp > end)) continue;
    if (entry.event === 'formal_conversation_request_detected') requests.set(details.requestId, details);
    if (entry.event === 'conversation_response_metadata_observed') responses.set(details.requestId, details);
    if (entry.event === 'response_evaluated') evaluations.set(details.requestId, details);
  }

  const results = snapshot.results.map((sourceItem) => {
    const item = summarizeModelResult(sourceItem);
    const request = requests.get(item.requestId);
    const metadata = responses.get(item.requestId);
    const evaluation = evaluations.get(item.requestId);
    const rawResponseModel = item.rawResponseModel || asText(evaluation?.rawResponseModel || metadata?.rawResponseModel);
    // A later partial event may describe a different response or lack a model field.
    const modelEvidence = [evaluation, metadata].find((event) =>
      rawResponseModel && event?.rawResponseModel === rawResponseModel && event.responseModelField);
    return {
      ...item,
      responseRequestId: item.responseRequestId || (metadata || evaluation ? item.requestId : ''),
      transportResponseRequestId: asText(metadata?.transportRequestId),
      rawRequestModel: item.rawRequestModel || asText(request?.rawRequestModel),
      networkObservedRequestModel: item.networkObservedRequestModel || asText(request?.observedModel),
      rawResponseModel,
      responseModelField: item.responseModelField || asText(modelEvidence?.responseModelField),
      responseHttpStatus: item.responseHttpStatus ?? metadata?.httpStatus ?? evaluation?.diagnostics?.httpStatus ?? null,
      responseIssue: item.responseIssue || asText(evaluation?.evidenceIssue),
      evidenceSource: item.evidenceSource || asText(evaluation?.evidenceSource),
      responseVerdict: item.responseVerdict || asText(evaluation?.verdict),
      responseModelIdentity: item.responseModelIdentity || safeModelIdentity(evaluation?.modelIdentity),
      requestEvidenceSource: asText(request?.requestEvidenceSource),
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
    submitted: Number.isInteger(details.submitted) ? details.submitted : null,
    nativeResponseConfirmed: Number.isInteger(details.nativeResponseConfirmed) ? details.nativeResponseConfirmed : null,
    workNativeResponseObserved: Number.isInteger(details.workNativeResponseObserved) ? details.workNativeResponseObserved : null,
    workNativeResponseMetadataConfirmed: Number.isInteger(details.workNativeResponseMetadataConfirmed) ? details.workNativeResponseMetadataConfirmed : null,
    chatLockSupported: Number.isInteger(details.chatLockSupported) ? details.chatLockSupported : null,
    fourGateEligible: Number.isInteger(details.fourGateEligible) ? details.fourGateEligible : null,
    shared: Number.isInteger(details.shared) ? details.shared : null,
    generation: Number.isInteger(details.generation) ? details.generation : null,
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
    'networkObservedRequestModel', 'responseModel', 'rawResponseModel', 'requestEvidenceSource',
    'responseIssue', 'responseHttpStatus', 'pickerMode', 'model',
    'streamCaptureBytes', 'streamCaptureOverflowed',
    'observedModel', 'forwardedModel', 'originalResponseModel', 'responseModelField',
    'responseVerdict', 'verdict', 'decision', 'httpStatus', 'transportRequestId',
    'nativeResponseConfirmed', 'workNativeResponseObserved',
    'workNativeResponseMetadataConfirmed', 'chatLockSupported',
    'fourGateEligible', 'shared', 'submitted', 'generation',
  ];
  const selected = {};
  for (const key of allowed) {
    if (Object.hasOwn(details, key)) selected[key] = details[key];
  }
  if (Array.isArray(details.models)) selected.models = details.models.map(summarizeModelResult);
  if (entry?.event === 'model_discovery_completed') selected.results = asArray(details.results).map(summarizeModelResult);
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
      .filter((entry) => ['formal_conversation_request_detected', 'conversation_response_metadata_observed'].includes(entry?.event)
        || entry?.component === 'discovery'
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
