import {
  DEFAULT_POLICY,
  DEFAULT_SETTINGS,
  modelTransportId,
  normalizeConcreteModelId,
  normalizePolicy,
  normalizeReasoningLevel,
  normalizeSettings,
} from './policy.js';
import { ChatGptNetworkMonitor } from './network-monitor.js';
import { evaluateGuard } from './guard.js';
import { classifyNativeError } from './native-status.js';
import {
  appendDiagnosticSseCapture,
  appendRuntimeLog,
  clearRuntimeLogs,
  createDiagnosticSseCapture,
  finalizeDiagnosticSseCapture,
  getRuntimeLogs,
  markRuntimeLogsNative,
  runtimeLogNativeBatch,
  uploadRuntimeLogBatch,
  RUNTIME_LOG_UPLOAD_ALARM,
  RUNTIME_LOG_SYNC_KEY,
  sanitizeLogValue,
} from './runtime-log.js';
import { createAccountClient } from './account-client.js';
import {
  effectivePolicyForTabSync,
  requestPolicyForTabSync,
  enableWorkModeForVerification,
  tabFeatureEnabledSync,
} from './tab-feature-runtime.js';
import { ACCOUNT_REFRESH_ALARM } from './account-refresh-scheduler.js';
import {
  createVerificationCatalog,
  summarizeVerificationOutcome,
  createModelVerificationHistoryRecord,
  shouldRetryTransientResponse,
  publishableVerificationResults,
} from './vendor/modelpro/model-verification.js';

const RUNTIME_CODE_VERSION = '0.5.160';
const NATIVE_HOST = 'com.gptlock.core';
const RECONNECT_ALARM = 'gptlock-native-reconnect';
