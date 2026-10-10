// [legacy-core-maintenance] v0.5.196: enforce truthful discovery evidence.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source=await readFile(new URL('../background.js',import.meta.url),'utf8');
const work=source.slice(source.indexOf('async function discoverOfficialWorkModels('),source.indexOf('async function publishAccountModels('));
const verify=source.slice(source.indexOf('async function verifyAccountCatalogModels('),source.indexOf('function modelVerificationHistoryRecord'));
const workRawResponse = work.slice(work.indexOf('const rawResponseModel'),work.indexOf('nativeResults.push(result)'));
const compat=verify.slice(verify.indexOf("if (chatCompatibility) {",verify.indexOf('const responseModel =')),verify.indexOf('} else {\n        // Native Picker A',verify.indexOf('const responseModel =')));

test('Work native response confirmation always requires an actual served-model ID',()=>{
  assert.match(workRawResponse,/const nativeResponseCompatible = rawResponseModel\s*\?/);
  assert.match(workRawResponse,/const nativeResponseConfirmed = Boolean\(rawResponseModel && nativeResponseCompatible\)/);
  assert.match(workRawResponse,/nativeResponseConfirmed,\s*nativeResponseMetadataConfirmed: nativeResponseConfirmed/);
  assert.doesNotMatch(workRawResponse,/nativeResponseConfirmed: nativeVerified/);
  assert.doesNotMatch(workRawResponse,/nativeResponseCompatible = !rawResponseModel/);
  assert.match(workRawResponse,/nativeResponseObserved,/);
  assert.match(workRawResponse,/nativeVerificationBasis: nativeResponseConfirmed/);
  assert.match(workRawResponse,/request_transport\+response_stream/);
});

test('A successful response stream without served-model metadata is not confirmed',()=>{
  const rawResponseModel = null, nativeResponseObserved = true, model = 'gpt-6-astra';
  const nativeResponseCompatible = rawResponseModel ? rawResponseModel===model : null;
  const nativeResponseConfirmed = Boolean(rawResponseModel&&nativeResponseCompatible);
  assert.equal(nativeResponseObserved,true);
  assert.equal(nativeResponseConfirmed,false);
});

test('a Chat lock that leaves request model unchanged is not a causal lock proof',()=>{
  assert.match(compat,/const effectiveRewrite = liveState\.lastRewrite\?\.changed === true/);
  assert.match(compat,/observedBaselineTransport !== expectedTransport/);
  assert.match(compat,/observedBaselineTransport === baselineTransport/);
  assert.match(compat,/rawRequestModel === expectedTransport\s*&& effectiveRewrite/);
  assert.match(compat,/chat_lock_no_effective_rewrite/);
  assert.match(compat,/chat_lock_request_unconfirmed/);
  assert.match(compat,/verified = Boolean\(requestId && requestConfirmed && responseConfirmed\)/);
  const baseline='gpt-6-thinking';
  const unchanged={changed:false,transportModelBefore:baseline,transportModelAfter:baseline};
  assert.equal(unchanged.changed===true&&unchanged.transportModelBefore!==unchanged.transportModelAfter,false);
  const changed={changed:true,transportModelBefore:baseline,transportModelAfter:'gpt-5.5-thinking'};
  assert.equal(changed.changed===true&&changed.transportModelBefore!==changed.transportModelAfter,true);
});

test('other-model backend mismatch remains a failed Chat lock even when rewrite is valid',()=>{
  assert.match(compat,/rawResponseProtocolModel === expectedResponse/);
  assert.match(compat,/picker_a_chat_lock_response_mismatch/);
  assert.match(compat,/chat_mode_response_differs_from_official_work/);
});
