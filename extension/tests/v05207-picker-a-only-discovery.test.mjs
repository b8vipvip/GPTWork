// Picker A-only discovery regression: fresh Chat turns and request-scoped response truth.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createVerificationCatalog, shouldRetryTransientResponse } from '../vendor/modelpro/model-verification.js';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const verifyStart = background.indexOf('async function verifyAccountCatalogModels(');
const verifyEnd = background.indexOf('function modelVerificationHistoryRecord(', verifyStart);
const verifySource = background.slice(verifyStart, verifyEnd);
const autoStart = background.indexOf('async function autoVerify(');
const autoEnd = background.indexOf('function diagnosticTabState(', autoStart);
const autoSource = background.slice(autoStart, autoEnd);

const row = { model: 'gpt-5.5', rawId: 'gpt-5.5', label: 'GPT-5.5', selectorKey: 'owned-picker-a-row', pickerMode: 'A' };
const pickerA = { pickerMode: 'A', rows: [row], models: ['gpt-5.5'], reasoningLevels: [] };
const raw = value => value ? String(value) : null;
const concrete = value => value ? String(value).replace(/-thinking$/, '') : null;
const pickerFamily = value => {
  const model = concrete(value);
  return model === 'gpt-5.6' ? 'gpt-5.6-sol' : model;
};
const transportFor = model => `${String(model || 'gpt-5.5').replace(/-sol$/, '')}-thinking`;
const goodStream = evidence => Boolean(
  evidence
  && evidence.diagnostics?.httpStatus === 200
  && evidence.diagnostics?.parsedObjectCount > 0
  && !evidence.bodyError
  && !evidence.conflicts?.model
);

async function runPickerA({ nativeResponse = null, lockResponse = null, staleLockResponse = false, failedLockStream = false, baselineMismatch = false, pickerMode = 'A', pickerModels = ['gpt-5.5', 'gpt-6'] } = {}) {
  const activeCatalog = Array.isArray(pickerModels) && pickerModels.length
    ? {
      pickerMode: 'A',
      rows: pickerModels.map(model => ({ model, rawId: model, label: model, selectorKey: `picker-${model}`, pickerMode: 'A' })),
      models: pickerModels,
      reasoningLevels: [],
    }
    : pickerA;
  const state = { autoVerification: { running: true } };
  const transactions = new Map();
  const events = [];
  const baselines = [];
  let currentBaseline = null;
  let isolatedSessions = 0;
  let sent = 0;
  const runtime = {
    createVerificationCatalog,
    shouldRetryTransientResponse,
    AUTO_VERIFY_RESPONSE_TIMEOUT_MS: 120000,
    normalizeConcreteModelId: concrete,
    normalizeRawProtocolModelId: raw,
    nativeChatPickerFamily: pickerFamily,
    successfulConversationResponseEvidence: goodStream,
    verificationTransactions: transactions,
    logRuntime: (_level, _category, event) => events.push(event),
    broadcastVerificationState: async () => {},
    sleep: async () => {},
    resetVerificationAttempt: current => {
      current.lastRequest = null;
      current.lastResponseEvidence = null;
      current.lastRewrite = null;
    },
    ensureTabState: () => state,
    requireVerificationOfficialChatMode: async () => {
      if (pickerMode !== 'A') throw new Error('official_chat_mode_unconfirmed');
      return { confirmed: true, pickerMode: 'A' };
    },
    prepareSharedChatLockVerificationSurface: async (_tab, _owner, _item, shared) => {
      shared.prepared = true;
      shared.attempts = (shared.attempts || 0) + 1;
      shared.conversationPathname = null;
      isolatedSessions += 1;
      currentBaseline = null;
      return { state };
    },
    pinSharedChatLockConversation: async () => {},
    shouldRetrySharedChatLockReplyLoss: () => false,
    shouldRetrySharedChatLockPreProbeReadiness: () => false,
    discoverAccountCatalog: async () => activeCatalog,
    networkMonitor: {
      isAttached: () => true,
      attach: async () => true,
      enableResponseCapture: async () => true,
    },
    sendTabMessage: async (_tab, message) => {
      if (message.type === 'GPTLOCK_VERIFY_ACCOUNT_MODEL') {
        if (transactions.get(7)?.mode === 'force-transport') {
          currentBaseline = message.model;
          baselines.push({ target: transactions.get(7)?.model, baseline: message.model, session: isolatedSessions });
        }
        return { result: { selectionAttempted: true, uiConfirmed: true, observation: { model: message.model } } };
      }
      if (message.type === 'GPTLOCK_WAIT_FOR_PROBE_SETTLED') return { settled: true };
      throw new Error('unexpected message ' + message.type);
    },
    sendVerificationReasoningProbe: async () => {
      sent += 1;
      const transaction = transactions.get(7);
      const lock = transaction?.mode === 'force-transport';
      const model = transaction?.model || 'gpt-5.5';
      const transport = transportFor(model);
      const requestId = 'real-request-' + sent;
      state.lastRequest = {
        requestId, capturedAt: new Date().toISOString(),
        model: lock ? currentBaseline : model,
        rawModel: lock ? transportFor(currentBaseline) : transport,
      };
      state.lastRewrite = lock ? {
        authorityKind: 'model-discovery-chat-compat',
        authorityModel: model,
        requestId,
        transportModelBefore: baselineMismatch && model === 'gpt-5.5' ? transport : transportFor(currentBaseline),
        transportModelAfter: transport,
        changed: true, capturedAt: new Date().toISOString(),
      } : null;
      state.lastResponseEvidence = {
        requestId: lock && staleLockResponse && model === 'gpt-5.5' ? 'other-request' : requestId,
        rawModel: lock && model === 'gpt-5.5' ? (lockResponse || transport) : !lock && model === 'gpt-5.5' ? (nativeResponse || transport) : transport,
        model: lock && model === 'gpt-5.5' ? (lockResponse || transport) : !lock && model === 'gpt-5.5' ? (nativeResponse || transport) : transport,
        diagnostics: { httpStatus: 200, parsedObjectCount: 1 },
        bodyError: lock && failedLockStream && model === 'gpt-5.5' ? 'net::ERR_HTTP2_PROTOCOL_ERROR' : null,
      };
      return { sent: true, assistantCountBefore: 0 };
    },
    waitForNetworkModelEvidence: async () => ({
      requestId: state.lastRequest?.requestId,
      evidence: state.lastResponseEvidence,
      timedOut: false,
    }),
    recoverStaleVerificationTurn: async () => ({ settled: false }),
    errorText: error => String(error?.message || error),
  };
  vm.createContext(runtime);
  const verify = vm.runInContext(verifySource + '\nverifyAccountCatalogModels', runtime);
  const progress = await verify(7, state, activeCatalog, { ownerTabId: 7 });
  return { progress, sent, events, baselines, isolatedSessions };
}

test('discovery has no Work entry/Picker B stage, even if legacy helper still exists', () => {
  assert.match(verifySource, /discoveryMode = 'picker-a-chat-only'/);
  assert.match(verifySource, /pickerMode !== 'A'/);
  assert.match(verifySource, /picker_a_chat_lock_queued/);
  assert.doesNotMatch(verifySource, /await discoverOfficialWorkModels\(/);
  assert.doesNotMatch(verifySource, /officialWorkDiscoveryDone/);
  assert.doesNotMatch(verifySource, /loadAccountModelVerificationLedger\(/);
  assert.doesNotMatch(verifySource, /reusedFromServer/);
  assert.match(autoSource, /await requireVerificationOfficialChatMode\(tabId, \{ model: null \}, \{ switchIfNeeded: true \}\);/);
  assert.doesNotMatch(autoSource, /official_work_model_discovery_incomplete/);
});

test('real Picker A native turn and force-locked Chat turn must both receive the matching model response', async () => {
  const { progress, sent, events } = await runPickerA();
  assert.equal(sent, 4, JSON.stringify({ results: progress.results, events }));
  assert.equal(progress.discoveryMode, 'picker-a-chat-only');
  assert.equal(progress.total, 4);
  assert.equal(progress.verified, 4);
  assert.equal(progress.results[0].nativeResponseConfirmed, true);
  assert.equal(progress.results[2].chatLockSupported, true);
  assert.equal(progress.results[2].rawResponseModel, 'gpt-5.5-thinking');
  assert.deepEqual([...progress.pickerModes], ['A']);
  assert.equal(events.some(event => event.includes('official_work_model_native_started')), false);
});

test('three native Picker A models still enqueue three forced Chat-lock probes after the stable-pass threshold', async () => {
  const { progress, sent, events } = await runPickerA({ pickerModels: ['gpt-5.5', 'gpt-5.6-sol', 'gpt-6'] });
  assert.equal(sent, 6, JSON.stringify({ results: progress.results, events }));
  assert.equal(progress.total, 6);
  assert.equal(progress.verified, 6);
  assert.equal(progress.failed, 0);
  assert.equal(progress.results.filter(item => item.nativeStageComplete).length, 3);
  assert.equal(progress.results.filter(item => item.chatLockSupported).length, 3);
  assert.equal(progress.results.filter(item => item.chatLockStageComplete).length, 3);
  assert.equal(events.filter(event => event === 'picker_a_chat_lock_queued').length, 1);
  assert.equal(events.filter(event => event === 'picker_a_chat_lock_completed').length, 3);
  assert.deepEqual([...progress.pickerModes], ['A']);
  assert.equal(isolatedSessions, 3);
  assert.equal(baselines.length, 3);
  for (const row of baselines) {
    assert.notEqual(row.target, row.baseline);
    assert.ok(row.session >= 1 && row.session <= 3);
  }
  assert.equal(new Set(baselines.map(row => row.session)).size, 3);
  assert.equal(progress.results.filter(row => row.chatLockSupported && row.baselineSelectionAttempted).length, 3);
});

test('wrong served model in native Picker A cannot queue a successful lock', async () => {
  const { progress, sent } = await runPickerA({ nativeResponse: 'gpt-6' });
  assert.equal(sent, 2);
  assert.equal(progress.results[0].verified, false);
  assert.equal(progress.results[0].responseConfirmed, false, JSON.stringify(progress.results));
  assert.equal(progress.results.filter(row => row.model === 'gpt-5.5' && row.chatLockSupported).length, 0);
});

test('wrong, stale, or failed Chat response never verifies the Picker A lock', async () => {
  for (const scenario of [
    { lockResponse: 'gpt-6' },
    { staleLockResponse: true },
    { failedLockStream: true },
  ]) {
    const { progress, sent } = await runPickerA(scenario);
    assert.equal(sent, 4);
    assert.equal(progress.results[0].verified, true);
    const firstLock = progress.results.find(row => row.model === 'gpt-5.5' && row.selectorKey === '__picker_a_chat_lock__');
    assert.equal(firstLock.verified, false);
    assert.equal(firstLock.chatLockSupported, false);
  }
});

test('single Picker A model cannot invent a distinct baseline or prove a no-op lock', async () => {
  const { progress, sent } = await runPickerA({ pickerModels: ['gpt-5.5'] });
  assert.equal(sent, 1);
  assert.equal(progress.results[0].verified, true);
  assert.equal(progress.results[1].chatLockSupported, false);
  assert.match(progress.results[1].error || '', /chat_lock_distinct_picker_a_baseline_unavailable/);
});

test('a mismatching original baseline cannot pass even if rewritten transport and response match', async () => {
  const { progress } = await runPickerA({ baselineMismatch: true });
  const firstLock = progress.results.find(row => row.model === 'gpt-5.5' && row.selectorKey === '__picker_a_chat_lock__');
  assert.equal(firstLock.verified, false);
  assert.equal(firstLock.requestConfirmed, false);
  assert.equal(firstLock.responseIssue, 'chat_lock_baseline_request_mismatch');
});

test('if official Chat mode cannot be confirmed no Picker A request is sent', async () => {
  const { progress, sent } = await runPickerA({ pickerMode: 'B' });
  assert.equal(sent, 0);
  assert.equal(progress.results[0].verified, false);
});
