// [legacy-core-maintenance] v0.5.203: an already-open owned Work
// catalog must bypass its old, occluded second-layer ViewToggle.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const start = source.indexOf('  function alreadyOpenOwnedWorkCatalog(');
const end = source.indexOf('  async function openModernModelMenu()', start);
assert.ok(start >= 0 && end > start, 'missing owned Work classification');
const body = source.slice(start, end);
const directChat = new Set(['gpt-6','gpt-5.6-sol','gpt-5.5']);
const make = (models, interactive=models, state='open') => {
  const rows=models.map(model=>({model}));
  const picker={getAttribute:key=>key==='data-state'?state:null};
  const scope={
    visible:()=>true,distinctModelRows:()=>rows,
    interactionVisible:row=>interactive.includes(row.model),
    rowModelDescriptor:row=>row,
    DIRECT_CHAT_MODEL_IDS:directChat,
  };
  vm.createContext(scope);
  const classify=vm.runInContext(body+'\nalreadyOpenOwnedWorkCatalog',scope);
  return Array.from(classify(picker),row=>row.model);
};
test('the eight-row Work directory is retained when already interactive',()=>{
  const work=['gpt-6.1-sol','gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5'];
  assert.deepEqual(make(work),work);
  assert.deepEqual(make(work,['gpt-6.1-sol','gpt-5.6-sol']),work);
});
test('Chat-only, closed, occluded, or insufficient catalogs never masquerade as Work',()=>{
  assert.deepEqual(make(['gpt-6','gpt-5.6-sol','gpt-5.5']),[]);
  assert.deepEqual(make(['gpt-6-astra']),[]);
  assert.deepEqual(make(['gpt-6-astra','gpt-5.5'],[]),[]);
  assert.deepEqual(make(['gpt-6-astra','gpt-5.5'],['gpt-5.5']),[]);
  assert.deepEqual(make(['gpt-6-astra','gpt-5.5'],undefined,'closed'),[]);
});
test('openModernModelMenu consults owned catalog before clicking stale submenu',()=>{
  const flow=source.slice(source.indexOf('async function openModernModelMenu('),source.indexOf('function rowModelDescriptor(', source.indexOf('async function openModernModelMenu(')));
  const before=flow.indexOf('alreadyOpenOwnedWorkCatalog(picker)');
  const stale=flow.indexOf('const initialOpener = modelSubmenuOpener(picker)');
  assert.ok(before>=0 && stale>before);
  assert.match(flow,/picker-mode-b-redesigned-already-open-owned-list/);
  assert.match(flow,/rows: alreadyOpenWorkRows, pageContext, pickerMode: 'B'/);
  assert.match(flow,/alreadyVisibleWorkCatalog/);
  assert.match(flow,/if \(redesignedDirectRows\.length >= 2\)/);
});
