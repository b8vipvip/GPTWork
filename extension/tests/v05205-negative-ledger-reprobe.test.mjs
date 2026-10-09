// [legacy-core-maintenance] v0.5.205: negative persistent verification evidence
// cannot prevent new on-device probes during subsequent model discovery.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  reusableConfirmedWorkNativeStage,
  reusableConfirmedChatLockStage,
} from '../vendor/modelpro/model-verification.js';
import { normalizeConcreteModelId, normalizeRawProtocolModelId } from '../policy.js';

const completeWork = {
  pickerMode: 'B', nativeStageComplete: true,
  requestConfirmed: true, responseConfirmed: true,
  nativeResponseConfirmed: true,
  nativeRequestModel: 'gpt-6-astra-wm',
  nativeResponseModel: 'gpt-6-astra-wm',
};
const completeLock = {
  pickerMode: 'B', chatLockStageComplete: true,
  chatLockSupported: true,
  chatLockRequestConfirmed: true,
  chatLockResponseConfirmed: true,
  chatAttemptTransport: 'gpt-6-astra-wm',
  chatAttemptResponseModel: 'gpt-6-astra-wm',
};
const lock = (prior, pickerMode = 'B', transportModel = 'gpt-6-astra-wm', expectedResponseModel = 'gpt-6-astra-wm') =>
  reusableConfirmedChatLockStage(prior, { pickerMode, transportModel, expectedResponseModel }, normalizeRawProtocolModelId);

test('stream-only Work success is never reused without raw served-model proof', () => {
  assert.equal(reusableConfirmedWorkNativeStage({ ...completeWork, nativeResponseModel: null, nativeResponseConfirmed: false }, 'gpt-6-astra', normalizeConcreteModelId), false);
  assert.equal(reusableConfirmedWorkNativeStage({ ...completeWork, nativeResponseModel: null }, 'gpt-6-astra', normalizeConcreteModelId), false);
  assert.equal(reusableConfirmedWorkNativeStage({ ...completeWork, nativeResponseModel: 'gpt-6-sol-wm' }, 'gpt-6-astra', normalizeConcreteModelId), false);
  assert.equal(reusableConfirmedWorkNativeStage({ ...completeWork, nativeRequestModel: 'gpt-5.5-wm' }, 'gpt-6-astra', normalizeConcreteModelId), false);
  assert.equal(reusableConfirmedWorkNativeStage(completeWork, 'gpt-6-astra', normalizeConcreteModelId), true);
});

test('negative Chat-lock result must be re-tested even when stage was marked complete', () => {
  assert.equal(lock({ ...completeLock, chatLockSupported: false }), false);
  assert.equal(lock({ ...completeLock, chatLockResponseConfirmed: false }), false);
  assert.equal(lock({ ...completeLock, chatLockRequestConfirmed: false }), false);
  assert.equal(lock({ ...completeLock, chatAttemptResponseModel: 'gpt-6' }), false);
  assert.equal(lock(completeLock, 'A'), false);
  assert.equal(lock(completeLock, 'B', 'gpt-5.5-wm'), false);
  assert.equal(lock(completeLock, 'B', 'gpt-6-astra-wm', null), false);
});

test('fully proven positive Chat lock is still reusable with exact transport and response identity', () => {
  assert.equal(lock(completeLock), true);
  const chat = {
    ...completeLock, pickerMode: 'A',
    chatAttemptTransport: 'gpt-5.5-thinking',
    chatAttemptResponseModel: 'gpt-5.5-thinking',
  };
  assert.equal(lock(chat, 'A', 'gpt-5.5-thinking', 'gpt-5.5-thinking'), true);
});

test('Work and Chat verification loops call strict history reuse gates', async () => {
  const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(background, /reusableConfirmedWorkNativeStage\(prior, model, normalizeConcreteModelId\)/);
  assert.match(background, /official_work_native_unconfirmed_stage_reprobe/);
  assert.match(background, /reusableConfirmedChatLockStage\(/);
  assert.match(background, /chat_lock_negative_stage_reprobe/);
  assert.match(background, /nativeResponseCompatible !== false/);
  assert.match(background, /rawResponseProtocolModel === expectedResponse/);
});
