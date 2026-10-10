// [legacy-core-maintenance] v0.5.195: a clicked GPT-6 row must not be
// rejected as Sol merely because the composer collapses to reasoning-only "High".
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [content, background] = await Promise.all([
  readFile(new URL('../content.js', import.meta.url), 'utf8'),
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
]);

test('inferred reasoning-only Sol is not an authoritative native selection veto', () => {
  const from = content.indexOf('async function selectModelForVerification(');
  const to = content.indexOf('async function chooseExact(', from);
  assert.ok(from >= 0 && to > from);
  const selection = content.slice(from, to);
  assert.match(selection, /const inferredOnly = observation\.modelEvidenceSource === 'open-picker-default-sol'/);
  assert.match(selection, /observation\.modelEvidenceSource === 'composer-redesign-default-sol'/);
  assert.match(selection, /const networkDeferred = !confirmed/);
  assert.match(selection, /return \{ attempted: true, observation, uiConfirmed: confirmed, networkDeferred: Boolean\(networkDeferred\) \}/);
  assert.doesNotMatch(selection, /networkDeferred = !confirmed[\s\S]{0,120}desired === 'gpt-5\.5' \|\| desired === 'gpt-5\.6-sol'/);
});

test('one native Picker A identity mapping works for request and served response', () => {
  const from = background.indexOf('function nativeChatPickerFamily(');
  const to = background.indexOf('async function verifyAccountCatalogModels(', from);
  assert.ok(from >= 0 && to > from);
  const block = background.slice(from, to);
  const runtime = {
    normalizeRawProtocolModelId: (v) => String(v || '').replace('gpt-5-6-thinking', 'gpt-5.6-thinking') || null,
    normalizeConcreteModelId: (v) => ({'gpt-6-astra-wm':'gpt-6-astra'}[v] || v),
  };
  vm.createContext(runtime);
  const family = vm.runInContext(block + '\nnativeChatPickerFamily', runtime);
  for (const [raw, expected] of [
    ['gpt-5.5-thinking', 'gpt-5.5'],
    ['gpt-5.6-thinking', 'gpt-5.6-sol'],
    ['gpt-6-thinking', 'gpt-6'],
    ['gpt-6', 'gpt-6'],
    ['gpt-6-astra-wm', 'gpt-6-astra'],
  ]) assert.equal(family(raw), expected, raw);
});

test('native discovery cannot verify GPT-6 from a Sol request/response despite a dispatched click', () => {
  const from = background.indexOf('async function verifyAccountCatalogModels(');
  const to = background.indexOf('function modelVerificationHistoryRecord', from);
  assert.ok(from >= 0 && to > from);
  const loop = background.slice(from, to);
  assert.match(loop, /nativeChatPickerFamily\(rawRequestModel\) === item\.model/);
  assert.match(loop, /nativeChatPickerFamily\(rawResponseProtocolModel\) === item\.model/);
  assert.match(loop, /verified = Boolean\(requestId && requestConfirmed && responseConfirmed\)/);
  assert.match(loop, /native_request_model_mismatch/);
  assert.match(loop, /native_response_model_mismatch/);
});

test('Chat-lock forced transport still strictly requires native exposed response identity', () => {
  assert.match(background, /rawResponseProtocolModel === expectedResponse/);
  assert.match(background, /native_response_model_not_exposed/);
});
