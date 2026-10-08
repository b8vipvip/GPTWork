// [legacy-core-maintenance] v0.5.198: response choice and incremental discovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [content, background, server, client] = await Promise.all([
  readFile(new URL('../content.js',import.meta.url),'utf8'),
  readFile(new URL('../background.js',import.meta.url),'utf8'),
  readFile(new URL('../../license-server/account-system-base.mjs',import.meta.url),'utf8'),
  readFile(new URL('../account-client.js',import.meta.url),'utf8'),
]);
function block(source,first,last) {
  const a=source.indexOf(first),b=source.indexOf(last,a+first.length);
  assert.ok(a>=0&&b>a,'missing '+first);
  return source.slice(a,b);
}

test('comparison preference clicks Answer 1 once using the owned card', async()=>{
  const source=block(content,'const discoveryComparisonChoices = new WeakSet();','async function waitForProbeTurnSettled(');
  let clicks=[];
  const button1={isConnected:true,parentElement:null,getAttribute(n){return n==='aria-label'?'我更喜欢这个回答':null}};
  const button2={isConnected:true,parentElement:null,getAttribute(n){return n==='aria-label'?'我更喜欢这个回答':null}};
  const card1={innerText:'回答 1 胡萝卜 我更喜欢这个回答',parentElement:null};
  const card2={innerText:'回答 2 胡萝卜 我更喜欢这个回答',parentElement:null};
  button1.parentElement=card1;button2.parentElement=card2;
  const ctx={
    WeakSet,location:{href:'https://chatgpt.com/c/a'},
    document:{querySelectorAll:()=>[button2,button1]},
    visible:()=>true,
    trustedPointer:async(element)=>{clicks.push(element);return true},
    pointerTrace:()=>{},compactElementProbe:()=>({}),
  };
  vm.createContext(ctx);
  const preference=vm.runInContext(source+'\nresolveDiscoveryComparisonChoice',ctx);
  const first=await preference();
  assert.equal(first.acted,true);
  assert.equal(clicks.length,1);
  assert.equal(clicks[0],button1);
  const second=await preference();
  assert.equal(second.pending,true);
  assert.equal(clicks.length,1);
  // Without both visible choices the page must not click any unrelated control.
  ctx.document.querySelectorAll=()=>[button1];
  assert.equal((await preference()).present,false);
  assert.equal(clicks.length,1);
});

test('comparison resolution is owned by existing waitForIdle and waitForProbeTurnSettled',()=>{
  const settle=block(content,'async function waitForProbeTurnSettled(','async function autoSendProbe(');
  const idle=block(content,'async function waitForIdle()','function verificationWorkControl(');
  assert.match(settle,/await resolveDiscoveryComparisonChoice\(\)/);
  assert.match(idle,/await resolveDiscoveryComparisonChoice\(\)/);
  assert.match(settle,/comparisonChoiceActuated/);
  assert.match(content,/discovery_comparison_answer_one_selected/);
});

test('account ledger is authenticated, contains incomplete models, and does not join deleted catalog entries',()=>{
  assert.match(server,/if \(path === '\/api\/v1\/account\/model-verifications' && req\.method === 'GET'\)/);
  assert.match(server,/const session = requireSession\(req\)/);
  assert.match(server,/accountModelVerificationLedger\(session\.user_id\)/);
  const ledger=block(server,'function accountModelVerificationLedger(userId)','function mergeSharedModelCatalog(');
  assert.match(ledger,/INNER JOIN shared_model_catalog c ON c\.model_id=s\.model_id/);
  assert.match(ledger,/WHERE s\.user_id=\? AND c\.enabled=1/);
  assert.match(ledger,/nativeStageComplete/);
  assert.match(ledger,/chatLockStageComplete/);
  assert.match(ledger,/chatAttemptTransport/);
  assert.match(client,/async function modelVerificationLedger\(\)/);
});

test('ledger stage histories are merged independently and negative completed locks are not promoted',()=>{
  assert.match(server,/native_stage_complete=MAX\(shared_model_account_seen\.native_stage_complete,excluded\.native_stage_complete\)/);
  assert.match(server,/chat_lock_stage_complete=MAX\(shared_model_account_seen\.chat_lock_stage_complete,excluded\.chat_lock_stage_complete\)/);
  assert.match(server,/chat_lock_response_confirmed=CASE WHEN excluded\.chat_lock_stage_complete=1/);
  assert.match(server,/last_chat_attempt_transport=CASE WHEN excluded\.chat_lock_stage_complete=1/);
  assert.match(server,/chatTransportModel = chatLockResponseConfirmed/);
  assert.match(server,/last_chat_attempt_response/);
  assert.match(server,/if \(nativeStageCompletionAdded\)/);
  assert.match(server,/request_confirmed=1 AND response_confirmed=1 AND native_request_model LIKE 'gpt-%'/);
  assert.match(server,/c\.picker_mode='A' AND shared_model_account_seen\.native_response_model LIKE 'gpt-%'/);
  assert.match(server,/OR c\.picker_mode='B'/);
});

test('loading the account stage ledger never seeds models absent from the live picker',async()=>{
  const loader=block(background,'async function loadAccountModelVerificationLedger()','async function verifyAccountCatalogModels(');
  const runtime={
    accountClient:{modelVerificationLedger:async()=>({ok:true,generation:8,models:[
      {model:'gpt-5.5',pickerMode:'A',nativeStageComplete:true,requestConfirmed:true,responseConfirmed:true,
       nativeRequestModel:'gpt-5.5-thinking',nativeResponseModel:'gpt-5.5-thinking'},
      {model:'gpt-6-astra',pickerMode:'B',nativeStageComplete:true,requestConfirmed:true,responseConfirmed:true,
       nativeRequestModel:'gpt-6-astra-wm'}
    ]})},
    normalizeConcreteModelId:x=>x,normalizeRawProtocolModelId:x=>x||null,
    logRuntime:()=>{},Number,Object,errorText:e=>String(e),
  };
  vm.createContext(runtime);
  const get=vm.runInContext(loader+'\nloadAccountModelVerificationLedger',runtime);
  const ledger=await get();
  assert.equal(ledger['gpt-5.5'].nativeStageComplete,true);
  assert.equal(ledger['gpt-6-astra'].nativeStageComplete,true);
  const schedule=block(background,'async function verifyAccountCatalogModels(','function modelVerificationHistoryRecord');
  assert.match(schedule,/mergeCatalog\(accountCatalog, 'chat-picker-a'\)/);
  assert.match(schedule,/const item = queue\[index\]/);
  assert.match(schedule,/model_verification_stage_reused/);
  assert.match(schedule,/previous\?\.chatAttemptTransport === normalizeRawProtocolModelId\(item\.transportModel\)/);
  const work=block(background,'async function discoverOfficialWorkModels(','async function publishAccountModels');
  assert.match(work,/official_work_native_stage_reused/);
  const publish=block(background,'async function publishAccountModels(','async function discoverAccountCatalog');
  assert.match(publish,/nativeStageComplete:/);
  assert.match(publish,/chatLockStageComplete:/);
  assert.match(publish,/chatAttemptResponseModel/);
});
