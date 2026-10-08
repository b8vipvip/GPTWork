// [legacy-core-maintenance] v0.5.199 regression from Work picker snapshot
// 2026-10-08T10:57:50Z: B list is already open but stale inner opener is occluded.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const content=await readFile(new URL('../content.js',import.meta.url),'utf8');
const begin=content.indexOf('    const alreadyVisibleModels = alreadyVisibleRows.map(');
const end=content.indexOf('    if (!initialOpener) {',begin);
assert.ok(begin>=0&&end>begin,'missing owned-model-list early classifier');
const section=content.slice(begin,end);

function evaluate(rows,{opener={isConnected:true}}={}) {
  const logs=[];
  const runtime={
    alreadyVisibleRows: rows.map((model)=>({name:model})),
    initialOpener:opener,
    DIRECT_CHAT_MODEL_IDS:new Set(['gpt-6','gpt-5.6-sol','gpt-5.5']),
    rowModelDescriptor:(row)=>({model:row.name}),
    pickerTopologyProbe:(event,details)=>logs.push({event,details}),
    compactElementProbe:()=>({}),
    pageContext:'new-chat',
    trigger:{},picker:{},alreadyVisibleAdvanced:{},
  };
  vm.createContext(runtime);
  const fn=vm.runInContext('(function(){\n'+section+'\nreturn {fellThrough:true};})',runtime);
  return {result:fn(),logs};
}

test('B-exclusive identities in the already-owned Work catalog win even with stale submenu opener',()=>{
  const models=['gpt-6.1-sol','gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5'];
  const {result,logs}=evaluate(models);
  assert.equal(result.pickerMode,'B');
  assert.equal(result.rows.length,8);
  assert.equal(result.submenu!==null,true);
  assert.equal(logs[0].event,'picker-mode-b-already-open-owned-catalog');
});

test('three official Chat-only models never become Picker B just because the menu is open',()=>{
  const {result}=evaluate(['gpt-6','gpt-5.6-sol','gpt-5.5']);
  assert.equal(result.fellThrough,true);
  assert.equal(result.pickerMode,undefined);
});

test('without an opener, inline direct Chat list remains mode A',()=>{
  const {result,logs}=evaluate(['gpt-5.6-sol','gpt-5.5'],{opener:null});
  assert.equal(result.pickerMode,'A');
  assert.equal(logs[0].event,'picker-mode-a-advanced-inline-list');
});

test('the B already-open early return occurs before any stale submenu pointer transaction',()=>{
  const open=content.slice(content.indexOf('async function openModernModelMenu()'),
    content.indexOf('function rowModelDescriptor(',content.indexOf('async function openModernModelMenu()')));
  assert.ok(open.indexOf("picker-mode-b-already-open-owned-catalog")<open.indexOf("'model-picker-submenu'"));
  assert.match(open,/alreadyVisibleWorkCatalog \|\| \(alreadyVisibleRows\.length && !initialOpener\)/);
  assert.doesNotMatch(section,/modelPickerPointer|dispatchSyntheticPointer/);
});
