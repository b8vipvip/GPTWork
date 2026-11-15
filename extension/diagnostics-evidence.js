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
  ];
  const selected = {};
  for (const key of allowed) {
    if (Object.hasOwn(details, key)) selected[key] = details[key];
  }
  if (Array.isArray(details.models)) selected.models = details.models.map(summarizeModelResult);
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
  const latest = selectLatestVerification({
    tabs: asArray(bundle.tabs),
    history: historyEnabled === true ? asArray(history) : [],
    runtimeLogs: logs,
  });
  const stream = summarizeStreamCapture(streamCapture || bundle.autoVerificationStream);
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
      latest: latest ? {
        ...latest,
        results: latest.results.map(summarizeModelResult),
      } : null,
      history: historyEnabled === true
        ? asArray(history).slice(0, 50).map((record) => {
          const snapshot = makeSnapshot(record, 'model-history');
          return snapshot ? { ...snapshot, results: snapshot.results.map(summarizeModelResult) } : null;
        }).filter(Boolean)
        : [],
    },
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
