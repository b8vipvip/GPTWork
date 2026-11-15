import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelVerificationHistoryRecord } from '../vendor/modelpro/model-verification.js';

const attempts = [
  {
    attempt: 1, sent: true, requestLockConfirmed: true,
    requestModel: 'gpt-6-astra', responseModel: 'gpt-6',
    responseConfirmed: false, responseIssue: 'family_only_response',
    evidenceSource: 'network_response_metadata',
    verdict: 'incomplete', outcome: 'unverified',
    reason: 'response_model_evidence_incomplete',
  },
  {
    attempt: 2, sent: true, requestLockConfirmed: true,
    requestModel: 'gpt-5.6-sol', responseModel: 'gpt-5.6-sol',
    responseConfirmed: true, evidenceSource: 'network_response_metadata',
    verdict: 'verified', outcome: 'verified',
  },
];

test('autoVerify attempts become persisted history when catalogVerification is null', () => {
  const record = createModelVerificationHistoryRecord(17, {
    startedAt: '2026-11-15T10:00:00.000Z',
    completedAt: '2026-11-15T10:02:00.000Z',
    sourceTabId: 17,
    executionTabId: 29,
    pageContext: 'existing_chat',
    verificationSurface: 'isolated_tab',
    maxAttempts: 2,
    outcome: 'partial',
    reason: 'response_model_evidence_incomplete',
    catalogVerification: null,
    attempts,
  });

  assert.equal(record.total, 2);
  assert.equal(record.requestConfirmed, 2);
  assert.equal(record.verified, 1);
  assert.equal(record.failed, 1);
  assert.equal(record.resultSource, 'attempts');
  assert.equal(record.sourceTabId, 17);
  assert.equal(record.executionTabId, 29);
  assert.equal(record.results.length, 2);
  assert.equal(record.results[0].requestConfirmed, true);
  assert.equal(record.results[0].responseConfirmed, false);
  assert.equal(record.results[0].responseIssue, 'family_only_response');
  assert.equal(record.results[1].verified, true);
  assert.equal(record.report.verification.results.length, 2);
});

test('full catalog evidence preserves distinct request, response, native and chat-lock gates', () => {
  const record = createModelVerificationHistoryRecord(5, {
    startedAt: '2026-11-15T11:00:00.000Z',
    completedAt: '2026-11-15T11:01:00.000Z',
    maxAttempts: 1,
    outcome: 'partial',
    catalogVerification: {
      total: 1, requestConfirmed: 1, verified: 0, failed: 1,
      results: [{
        model: 'gpt-6-astra', pickerMode: 'B',
        requestConfirmed: true, requestModel: 'gpt-6-astra-wm',
        rawRequestModel: 'gpt-6-astra-wm', requestId: 'req-1',
        responseConfirmed: true, responseModel: 'gpt-6',
        rawResponseModel: 'gpt-6', responseRequestId: 'req-1',
        responseModelField: 'message.metadata.resolved_model_slug',
        responseHttpStatus: 200, responseIssue: 'family_only',
        nativeStageComplete: true, nativeRequestConfirmed: true,
        nativeRequestModel: 'gpt-6-astra-wm', nativeResponseObserved: true,
        nativeResponseConfirmed: false, nativeResponseModel: 'gpt-6',
        chatLockStageComplete: true, chatLockSupported: false,
        chatLockRequestConfirmed: true, chatLockResponseConfirmed: false,
        chatAttemptTransport: 'gpt-6-astra-wm',
        chatAttemptResponseModel: 'gpt-6',
        fourGateEligible: false,
        responseModelIdentity: {
          status: 'family_only', requestedModel: 'gpt-6-astra',
          observedModel: 'gpt-6', responseField: 'message.metadata.resolved_model_slug',
          variantConfirmed: false, definitiveMismatch: false,
        },
        rawResponseBody: 'PRIVATE BODY MUST NOT BE COPIED',
      }],
    },
  });

  const result = record.results[0];
  assert.equal(record.resultSource, 'catalog');
  assert.equal(record.requestConfirmed, 1);
  assert.equal(result.rawRequestModel, 'gpt-6-astra-wm');
  assert.equal(result.rawResponseModel, 'gpt-6');
  assert.equal(result.responseRequestId, 'req-1');
  assert.equal(result.responseHttpStatus, 200);
  assert.equal(result.nativeStageComplete, true);
  assert.equal(result.nativeResponseObserved, true);
  assert.equal(result.nativeResponseConfirmed, false);
  assert.equal(result.chatLockStageComplete, true);
  assert.equal(result.chatLockSupported, false);
  assert.equal(result.chatLockRequestConfirmed, true);
  assert.equal(result.chatLockResponseConfirmed, false);
  assert.equal(result.fourGateEligible, false);
  assert.equal(result.responseModelIdentity.status, 'family_only');
  assert.equal(JSON.stringify(record).includes('PRIVATE BODY'), false);
});

test('missing gate evidence remains null instead of being converted into a negative verdict', () => {
  const record = createModelVerificationHistoryRecord(1, {
    startedAt: '2026-11-15T12:00:00.000Z',
    completedAt: '2026-11-15T12:01:00.000Z',
    maxAttempts: 1,
    attempts: [{ attempt: 1, outcome: 'unverified', requestLockConfirmed: true }],
  });
  const result = record.results[0];
  assert.equal(result.nativeStageComplete, null);
  assert.equal(result.nativeRequestConfirmed, null);
  assert.equal(result.nativeResponseConfirmed, null);
  assert.equal(result.chatLockStageComplete, null);
  assert.equal(result.chatLockSupported, null);
  assert.equal(result.chatLockRequestConfirmed, null);
  assert.equal(result.chatLockResponseConfirmed, null);
  assert.equal(result.rawResponseModel, null);
});

