import { extractResponseEvidence } from './network-evidence.js';

function array(value) {
  return Array.isArray(value) ? value : [];
}

function byteLength(value) {
  return new TextEncoder().encode(String(value ?? '')).byteLength;
}

function parseCapturedStream(entry) {
  const raw = typeof entry?.rawSse === 'string'
    ? entry.rawSse
    : typeof entry?.rawFrame === 'string'
      ? entry.rawFrame
      : '';
  if (!raw) return null;
  try {
    const evidence = extractResponseEvidence({
      body: raw,
      mimeType: entry?.mimeType || '',
    });
    return {
      parsed: true,
      rawModel: evidence.rawModel ?? null,
      model: evidence.model ?? null,
      field: evidence.fields?.model ?? null,
      candidatePaths: array(evidence.diagnostics?.modelCandidatePaths).slice(-12),
      candidateValues: array(evidence.diagnostics?.rawModelCandidateValues).slice(-12),
      conflict: evidence.conflicts?.model === true,
      bodyFormat: evidence.diagnostics?.bodyFormat ?? null,
      parsedObjectCount: Number(evidence.diagnostics?.parsedObjectCount || 0),
    };
  } catch (error) {
    return {
      parsed: false,
      error: String(error?.message || error).slice(0, 300),
      rawModel: null,
      model: null,
      field: null,
      candidatePaths: [],
      candidateValues: [],
      conflict: false,
    };
  }
}

function summarizeStreamEntry(entry) {
  const parsed = parseCapturedStream(entry);
  return {
    requestId: entry?.requestId ?? null,
    capturedAt: entry?.capturedAt ?? null,
    endpoint: entry?.endpoint ?? null,
    httpStatus: entry?.httpStatus ?? null,
    mimeType: entry?.mimeType ?? null,
    transport: entry?.transport ?? null,
    direction: entry?.direction ?? null,
    stage: entry?.stage ?? null,
    bodyBytes: Number(entry?.bodyBytes || byteLength(entry?.rawSse ?? entry?.rawFrame ?? '')),
    requestModel: entry?.requestModel ?? null,
    rewriteReason: entry?.rewriteReason ?? null,
    streamContext: entry?.streamContext ?? null,
    parsedResponseCandidate: parsed,
    verificationAuthority: false,
    note: 'Parsed diagnostic candidate only; this does not change or promote the runtime verification verdict.',
  };
}

function summarizeModelResult(item, streamEntries) {
  const requestId = item?.requestId ?? null;
  const responseRequestId = item?.responseRequestId ?? null;
  const correlatedIds = new Set([requestId, responseRequestId].filter(Boolean));
  const correlatedStreams = streamEntries.filter((entry) => entry.requestId && correlatedIds.has(entry.requestId));
  const streamEvidence = correlatedStreams.map(summarizeStreamEntry);
  const firstParsed = streamEvidence.find((entry) => entry.parsedResponseCandidate?.parsed
    && (entry.parsedResponseCandidate.rawModel || entry.parsedResponseCandidate.model));
  return {
    model: item?.model ?? item?.rawModel ?? null,
    label: item?.label ?? item?.model ?? item?.requestModel ?? 'Unknown model',
    pickerMode: item?.pickerMode ?? null,
    selected: item?.selected === true,
    verified: item?.verified === true,
    requestConfirmed: item?.requestConfirmed === true,
    responseConfirmed: item?.responseConfirmed === true,
    requestId,
    responseRequestId,
    requestModel: item?.requestModel ?? null,
    rawRequestModel: item?.rawRequestModel ?? item?.nativeRequestModel ?? null,
    networkObservedRequestModel: item?.networkObservedRequestModel ?? null,
    responseModel: item?.responseModel ?? item?.chatResponseModel ?? null,
    rawResponseModel: item?.rawResponseModel ?? item?.nativeResponseModel ?? null,
    responseModelField: item?.responseModelField ?? firstParsed?.parsedResponseCandidate?.field ?? null,
    responseModelCandidatePaths: array(item?.responseModelCandidatePaths).length
      ? array(item.responseModelCandidatePaths).slice(-12)
      : array(firstParsed?.parsedResponseCandidate?.candidatePaths).slice(-12),
    responseMetadataConflict: item?.responseMetadataConflict === true
      || firstParsed?.parsedResponseCandidate?.conflict === true,
    responseIssue: item?.responseIssue ?? item?.error ?? null,
    responseHttpStatus: item?.responseHttpStatus ?? null,
    responseNetworkError: item?.responseNetworkError ?? null,
    responseBodyError: item?.responseBodyError ?? null,
    responseTransport: item?.responseTransport ?? null,
    responseTerminalEvent: item?.responseTerminalEvent ?? null,
    timedOut: item?.timedOut === true,
    streamEvidence,
  };
}

export function createModelEvidenceDiagnosticReport(bundle = {}, { modelVerificationHistory = [], historyEnabled = false } = {}) {
  const streamCapture = bundle?.autoVerificationStream || null;
  const streamEntries = array(streamCapture?.entries);
  const tabs = array(bundle?.tabs);
  const verifications = [];

  for (const tab of tabs) {
    const auto = tab?.autoVerification;
    if (!auto || typeof auto !== 'object') continue;
    const catalog = auto.catalogVerification || {};
    const results = array(catalog.results).length ? array(catalog.results) : array(auto.results);
    verifications.push({
      sourceTabId: auto.sourceTabId ?? tab.tabId ?? null,
      executionTabId: auto.executionTabId ?? null,
      verificationSurface: auto.verificationSurface ?? null,
      pageContext: auto.pageContext ?? null,
      startedAt: auto.startedAt ?? null,
      completedAt: auto.completedAt ?? null,
      outcome: auto.outcome ?? 'unverified',
      reason: auto.reason ?? null,
      catalogTotal: Number(catalog.total ?? auto.total ?? results.length),
      catalogRequestConfirmed: Number(catalog.requestConfirmed ?? auto.requestConfirmed ?? 0),
      catalogVerified: Number(catalog.verified ?? auto.verified ?? 0),
      catalogFailed: Number(catalog.failed ?? auto.failed ?? 0),
      models: results.map((item) => summarizeModelResult(item, streamEntries)),
    });
  }

  return {
    schemaVersion: 1,
    type: 'gptwork-model-evidence-diagnostic-report',
    generatedAt: bundle?.generatedAt || new Date().toISOString(),
    extension: bundle?.extension ?? null,
    verificationRuns: verifications,
    modelVerificationHistory: {
      enabled: historyEnabled === true,
      recordCount: array(modelVerificationHistory).length,
      records: array(modelVerificationHistory),
    },
    runtimeLogs: array(bundle?.runtimeLogs),
    nativeDiagnostics: bundle?.nativeDiagnostics ?? null,
    nativeDiagnosticsError: bundle?.nativeDiagnosticsError ?? null,
    streamCapture: {
      included: streamEntries.length > 0,
      schemaVersion: streamCapture?.schemaVersion ?? null,
      captureScope: streamCapture?.captureScope ?? null,
      startedAt: streamCapture?.startedAt ?? null,
      completedAt: streamCapture?.completedAt ?? null,
      totalBytes: Number(streamCapture?.totalBytes || 0),
      includedBytes: Number(streamCapture?.includedBytes || 0),
      overflowed: streamCapture?.overflowed === true,
      omittedResponses: Number(streamCapture?.omittedResponses || 0),
      omittedBytes: Number(streamCapture?.omittedBytes || 0),
      entries: streamEntries.map(summarizeStreamEntry),
    },
    privacy: bundle?.privacy ?? null,
    evidencePolicy: {
      requestCorrelation: 'Stream entries are joined to model results only by exact requestId / responseRequestId.',
      parsedStreamAuthority: false,
      note: 'A model ID parsed from a captured stream is diagnostic evidence only. It never changes verified, requestConfirmed, or responseConfirmed.',
    },
  };
}
