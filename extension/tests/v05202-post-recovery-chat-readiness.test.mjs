// [legacy-core-maintenance] v0.5.202: bounded pre-probe readiness
// recovery after a loading-time content runtime reinjection.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const scope=(a,b)=>{const x=background.indexOf(a),y=background.indexOf(b,x+a.length);assert.ok(x>=0&&y>x,a);return background.slice(x,y);};
const waitSrc=scope('async function waitForVerificationSurface(', 'async function createVerificationExecutionTab(');
const helperSrc=scope('function shouldRetrySharedChatLockPreProbeReadiness(', 'async function verifyAccountCatalogModels(');
const shouldRetry=vm.runInNewContext(helperSrc+'\nshouldRetrySharedChatLockPreProbeReadiness');
const recoveryError={
  chatCompatibility:true,sharedSessionPrepared:true,probeDispatchStarted:false,
  retryCount:0,error:'Chat lock shared conversation not ready: composer_not_ready',
};
test('pre-probe readiness failures may retry the same model once without bypassing proof',()=>{
 assert.equal(shouldRetry(recoveryError),true);
 assert.equal(shouldRetry({...recoveryError,error:'official_chat_mode_unconfirmed:official_picker_mode_unresolved'}),true);
 assert.equal(shouldRetry({...recoveryError,retryCount:1}),false);
 for(const invalid of [
  {probeDispatchStarted:true},{sharedSessionPrepared:false},{chatCompatibility:false},
  {error:'official_chat_mode_unconfirmed:B'},
  {error:'Chat lock shared conversation changed'},
  {error:'network timeout'},
 ]) assert.equal(shouldRetry({...recoveryError,...invalid}),false);
});
test('late successful content runtime recovery has one grace period for the composer to become ready',async()=>{
 let clock=0,calls=0,graces=0;
 const runtime={
  Date:{now:()=>clock},
  Number,Math,
  chrome:{tabs:{get:async()=>({status:'loading',url:'https://chatgpt.com/'})}},
  verificationSurfaceStatus:async()=>{
   calls++;
   return {contentRuntimeReady:clock>=1150,composerReady:clock>=1800,modelTriggerReady:clock>=1800,documentVisible:true,pathname:'/',
     structuralReady:clock>=1800,reason:clock>=1800?null:'composer_not_ready'};
  },
  verificationSurfaceAccepted:v=>v.contentRuntimeReady&&v.composerReady&&v.modelTriggerReady,
  ensureContentRuntime:async()=>({ready:false}),
  ensureContentRuntimeDuringLoad:async()=>{clock=1150;return {ready:true,injected:true,reason:'recovered'};},
  isChatGptUrl:()=>true,
  logRuntime:(_level,_component,event)=>{if(event==='verification_surface_post_recovery_grace')graces++;},
  errorText:String,
  sleep:async ms=>{clock+=ms;},
 };
 vm.createContext(runtime);
 const wait=vm.runInContext(waitSrc+'\nwaitForVerificationSurface',runtime);
 const response=await wait(42,1200,{requireVisible:true});
 assert.equal(response.ready,true);
 assert.ok(clock>=1800,'composer should settle beyond original 1200ms timeout');
 assert.equal(graces,1);
 assert.ok(calls>=3);
});
test('post-recovery grace is limited and cannot claim success from runtime injection alone',async()=>{
 let clock=0,graces=0;
 const runtime={
  Date:{now:()=>clock},Number,Math,
  chrome:{tabs:{get:async()=>({status:'loading',url:'https://chatgpt.com/'})}},
  verificationSurfaceStatus:async()=>({contentRuntimeReady:true,composerReady:false,modelTriggerReady:false,documentVisible:true,pathname:'/',reason:'composer_not_ready'}),
  verificationSurfaceAccepted:v=>Boolean(v.composerReady&&v.modelTriggerReady),
  ensureContentRuntime:async()=>({ready:false}),
  ensureContentRuntimeDuringLoad:async()=>({ready:false}),
  isChatGptUrl:()=>true,logRuntime:(_l,_c,e)=>{if(e==='verification_surface_post_recovery_grace')graces++;},
  errorText:String,sleep:async ms=>{clock+=ms;},
 };
 vm.createContext(runtime);
 const wait=vm.runInContext(waitSrc+'\nwaitForVerificationSurface',runtime);
 const response=await wait(42,1200,{requireVisible:true});
 assert.equal(response.ready,false);
 assert.ok(clock<=1800);
 assert.equal(graces,0);
});
test('verification loop retries only before probe dispatch and preserves exact served-model gates',()=>{
 const verify=scope('async function verifyAccountCatalogModels(','function modelVerificationHistoryRecord(');
 assert.match(verify,/let probeDispatchStarted = false/);
 assert.match(verify,/probeDispatchStarted = true;\s*const probe = await sendVerificationReasoningProbe/);
 assert.match(verify,/shouldRetrySharedChatLockPreProbeReadiness\(\{/);
 assert.match(verify,/chat_lock_pre_probe_readiness_retry/);
 assert.match(verify,/const effectiveRewrite = liveState\.lastRewrite\?\.changed === true/);
 assert.match(verify,/rawResponseProtocolModel === expectedResponse/);
 assert.match(verify,/verified = Boolean\(requestId && requestConfirmed && responseConfirmed\)/);
});
