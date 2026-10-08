// [legacy-core-maintenance] v0.5.197 publishing must consume the stage-owned
// served-model truth rather than recomputing it from a successful response stream.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const start = source.indexOf('async function publishAccountModels(');
const end = source.indexOf('async function discoverAccountCatalog(', start);
assert.ok(start >= 0 && end > start);
const publishSource = source.slice(start,end);

test('Work successful stream without response ID remains unconfirmed during publish', async () => {
  const calls = [];
  const logs = [];
  const runtime = {
    normalizeConcreteModelId: (v) => v || null,
    normalizeRawProtocolModelId: (v) => v || null,
    accountClient: { publishSharedModels: async (models) => {
      calls.push(models);
      return {generation:23, models:[]};
    }},
    applyClientSharedModelCatalog: async () => [],
    accountState: {user:{id:1}},
    logRuntime: (_level,_source,event,details) => logs.push({event,details}),
    errorText: (e) => String(e),
    Map,
    Number,
    String,
  };
  vm.createContext(runtime);
  const publish = vm.runInContext(publishSource+'\npublishAccountModels',runtime);
  const nativeResults = [{
    model:'gpt-6-astra',label:'GPT-6 Astra',pickerMode:'B',
    nativeRequestModel:'gpt-6-astra-wm',nativeRequestConfirmed:true,
    nativeResponseModel:null,nativeResponseObserved:true,
    nativeResponseConfirmed:false,nativeVerified:true,
  }];
  await publish({rows:[{model:'gpt-6-astra',pickerMode:'B'}]},{
    officialWorkDiscovery:{nativeResults},results:[],
  });

  assert.equal(calls.length,1);
  assert.equal(calls[0].length,1);
  const model = calls[0][0];
  assert.equal(model.model,'gpt-6-astra');
  assert.equal(model.requestConfirmed,true);
  assert.equal(model.responseConfirmed,true); // the stream gate only
  assert.equal(model.nativeResponseConfirmed,false);
  assert.equal(model.nativeResponseModel,null);
  const summary = logs.find(x=>x.event==='shared_model_catalog_published').details;
  assert.equal(summary.nativeResponseConfirmed,0);
  assert.equal(summary.workNativeResponseObserved,1);
  assert.equal(summary.workNativeResponseMetadataConfirmed,0);
});

test('a real direct Chat served-model proof remains confirmed alongside Work stream-only models', async () => {
  let published = [];
  const runtime = {
    normalizeConcreteModelId: (v) => v || null,
    normalizeRawProtocolModelId: (v) => v || null,
    accountClient:{publishSharedModels:async models => {
      published=models;
      return {generation:23,models:[]};
    }},
    applyClientSharedModelCatalog:async()=>[],
    accountState:{user:{id:1}},
    logRuntime:()=>{},
    errorText:String,
    Map,
    Number,
    String,
  };
  vm.createContext(runtime);
  const publish=vm.runInContext(publishSource+'\npublishAccountModels',runtime);
  await publish({
    rows:[{model:'gpt-5.5',pickerMode:'A'},{model:'gpt-6-astra',pickerMode:'B'}],
  },{
    officialWorkDiscovery:{nativeResults:[{
      model:'gpt-6-astra',nativeRequestModel:'gpt-6-astra-wm',
      nativeRequestConfirmed:true,nativeResponseObserved:true,
      nativeVerified:true,nativeResponseConfirmed:false,
    }]},
    results:[{
      model:'gpt-5.5',pickerMode:'A',selectorKey:'gpt-5.5',
      requestConfirmed:true,responseConfirmed:true,
      rawRequestModel:'gpt-5.5-thinking',
      rawResponseModel:'gpt-5.5-thinking',
    }],
  });
  const byId=new Map(published.map(m=>[m.model,m]));
  assert.equal(byId.get('gpt-5.5')?.nativeResponseConfirmed,true);
  assert.equal(byId.get('gpt-6-astra')?.nativeResponseConfirmed,false);
});

test('the publisher has no independent Work nativeVerified-to-served-ID promotion',()=>{
  assert.doesNotMatch(publishSource,/nativeResponseConfirmed\s*=\s*current\.nativeResponseConfirmed\s*\|\|\s*item\?\.nativeResponseConfirmed === true\s*\|\|\s*item\?\.nativeVerified/);
  assert.match(publishSource,/workNativeResponseMetadataConfirmed/);
});
