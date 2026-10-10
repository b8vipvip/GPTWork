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
const goodStream = evidence => Boolean(
  evidence
  && evidence.diagnostics?.httpStatus === 200
  && evidence.diagnostics?.parsedObjectCount > 0
  && !evidence.bodyError
  && !evidence.conflicts?.model
);

async function runPickerA({ nativeResponse = 'gpt-5.5-thinking', lockResponse = 'gpt-5.5-thinking', staleLockResponse = false, failedLockStream = false, pickerMode = 'A' } = {}) {
  const state = { autoVerification: { running: true } };
  const transactions = new Map();
  const events = [];
  let sent = 0;
  const runtime = {
    createVerificationCatalog,
    shouldRetryTransientResponse,
    normalizeConcreteModelId: concrete,
    normalizeRawProtocolModelId: raw,
    nativeChatPickerFamily: concrete,
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
      return { state };
    },
    pinSharedChatLockConversation: async () => {},
    shouldRetrySharedChatLockReplyLoss: () => false,
    shouldRetrySharedChatLockPreProbeReadiness: () => false,
    discoverAccountCatalog: async () => pickerA,
    networkMonitor: {
      isAttached: () => true,
      attach: async () => true,
      enableResponseCapture: async () => true,
    },
    sendTabMessage: async (_tab, message) => {
      if (message.type === 'GPTLOCK_VERIFY_ACCOUNT_MODEL') {
        return { result: { selectionAttempted: true, observation: { model: 'gpt-5.5' } } };
      }
      if (message.type === 'GPTLOCK_WAIT_FOR_PROBE_SETTLED') return { settled: true };
      throw new Error('unexpected message ' + message.type);
    },
    sendVerificationReasoningProbe: async () => {
      sent += 1;
      const transaction = transactions.get(7);
      const lock = transaction?.mode === 'force-transport';
      const requestId = 'real-request-' + sent;
      state.lastRequest = {
        requestId, capturedAt: new Date().toISOString(),
        model: 'gpt-5.5', rawModel: 'gpt-5.5-thinking',
      };
      state.lastRewrite = lock ? {
        authorityKind: 'model-discovery-chat-compat',
        authorityModel: 'gpt-5.5',
        transportModelBefore: 'gpt-6',
        transportModelAfter: 'gpt-5.5-thinking',
        changed: true, capturedAt: new Date().toISOString(),
      } : null;
      state.lastResponseEvidence = {
        requestId: lock && staleLockResponse ? 'other-request' : requestId,
        rawModel: lock ? lockResponse : nativeResponse,
        model: lock ? lockResponse : nativeResponse,
        diagnostics: { httpStatus: 200, parsedObjectCount: 1 },
        bodyError: lock && failedLockStream ? 'net::ERR_HTTP2_PROTOCOL_ERROR' : null,
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
  const progress = await verify(7, state, pickerA, { ownerTabId: 7 });
  return { progress, sent, events };
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
  assert.equal(sent, 2);
  assert.equal(progress.discoveryMode, 'picker-a-chat-only');
  assert.equal(progress.total, 2);
  assert.equal(progress.verified, 2);
  assert.equal(progress.results[0].nativeResponseConfirmed, true);
  assert.equal(progress.results[1].chatLockSupported, true);
  assert.equal(progress.results[1].rawResponseModel, 'gpt-5.5-thinking');
  assert.deepEqual([...progress.pickerModes], ['A']);
  assert.equal(events.some(event => event.includes('official_work_model_native_started')), false);
});

test('wrong served model in native Picker A cannot queue a successful lock', async () => {
  const { progress, sent } = await runPickerA({ nativeResponse: 'gpt-6' });
  assert.equal(sent, 1);
  assert.equal(progress.verified, 0);
  assert.equal(progress.results[0].responseConfirmed, false);
});

test('wrong, stale, or failed Chat response never verifies the Picker A lock', async () => {
  for (const scenario of [
    { lockResponse: 'gpt-6' },
    { staleLockResponse: true },
    { failedLockStream: true },
  ]) {
    const { progress, sent } = await runPickerA(scenario);
    assert.equal(sent, 2);
    assert.equal(progress.results[0].verified, true);
    assert.equal(progress.results[1].verified, false);
    assert.equal(progress.results[1].chatLockSupported, false);
  }
});

test('if official Chat mode cannot be confirmed no Picker A request is sent', async () => {
  const { progress, sent } = await runPickerA({ pickerMode: 'B' });
  assert.equal(sent, 0);
  assert.equal(progress.results[0].verified, false);
});
