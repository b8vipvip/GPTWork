const $=(id)=>document.getElementById(id);
const el={
  login:$('login'),app:$('app'),password:$('password'),loginButton:$('loginButton'),loginMessage:$('loginMessage'),logout:$('logout'),
  body:$('modelsBody'),refresh:$('refreshModels'),generation:$('generation'),message:$('modelsMessage'),
  selectAll:$('selectAllModels'),deleteSelected:$('deleteSelectedModels'),
  trashBody:$('trashBody'),trashCount:$('trashCount'),selectAllTrash:$('selectAllTrash'),restoreSelected:$('restoreSelectedModels')
};
async function api(path,options={}){
  const response=await fetch(path,{credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json',...(options.headers||{})},...options});
  const body=await response.json().catch(()=>({}));
  if(!response.ok||body.ok===false){const e=new Error(body?.error?.message||'请求失败');e.status=response.status;throw e;}
  return body;
}
function esc(value){return String(value??'').replace(/[&<>"']/g,(ch)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function fmt(value){if(!value)return '—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString();}
function selected(body,selector){return [...body.querySelectorAll(selector)].map((input)=>input.value).filter(Boolean);}
function syncSelection(){
  const active=selected(el.body,'input[data-select-model]:checked');
  const activeTotal=el.body.querySelectorAll('input[data-select-model]').length;
  el.deleteSelected.disabled=active.length===0;
  el.selectAll.checked=activeTotal>0&&active.length===activeTotal;
  el.selectAll.indeterminate=active.length>0&&active.length<activeTotal;
  const trash=selected(el.trashBody,'input[data-select-trash]:checked');
  const trashTotal=el.trashBody.querySelectorAll('input[data-select-trash]').length;
  el.restoreSelected.disabled=trash.length===0;
  el.selectAllTrash.checked=trashTotal>0&&trash.length===trashTotal;
  el.selectAllTrash.indeterminate=trash.length>0&&trash.length<trashTotal;
}
function render(data){
  const models=Array.isArray(data.models)?data.models:[];
  const trash=Array.isArray(data.trash)?data.trash:[];
  el.generation.textContent=`目录代次 ${Number(data.generation||0)} · ${models.length} 个活动模型`;
  el.trashCount.textContent=`${trash.length} 个已删除模型`;
  el.body.innerHTML=models.map((m)=>`<tr data-model="${esc(m.model)}">
    <td><input data-select-model type="checkbox" value="${esc(m.model)}" aria-label="选择 ${esc(m.model)}"></td>
    <td><code>${esc(m.model)}</code></td>
    <td><input data-field="label" value="${esc(m.label||m.model)}" maxlength="120"></td>
    <td><select data-field="pickerMode"><option value="">—</option><option value="A" ${m.pickerMode==='A'?'selected':''}>A</option><option value="B" ${m.pickerMode==='B'?'selected':''}>B</option></select></td>
    <td><code>${esc(m.nativeRequestModel||'—')}</code><br><small>${esc(m.nativeResponseModel||'—')}</small></td>
    <td><code>${esc(m.chatTransportModel||'—')}</code><br><small>${esc(m.chatResponseModel||'—')}</small></td>
    <td>${Number(m.chatLockVerifiedCount||0)>0?'✅':'—'} (${Number(m.chatLockVerifiedCount||0)})</td>
    <td><input data-field="enabled" type="checkbox" ${m.enabled!==false?'checked':''}></td>
    <td>发现 ${Number(m.accountCount||0)} / 请求 ${Number(m.requestConfirmedAccountCount||0)} / 原生响应 ${Number(m.verifiedAccountCount||0)} / Chat锁定 ${Number(m.chatLockVerifiedAccountCount||0)}</td>
    <td>${Number(m.discoveredCount||0)}</td><td>${esc(fmt(m.lastSeenAt))}</td>
    <td><button data-action="save">保存</button> <button data-action="delete" class="danger">删除</button></td>
  </tr>`).join('')||'<tr><td colspan="12" class="muted">活动模型目录为空，可以从客户端执行“发现模型”重新构建。</td></tr>';
  el.trashBody.innerHTML=trash.map((m)=>`<tr data-model="${esc(m.model)}">
    <td><input data-select-trash type="checkbox" value="${esc(m.model)}" aria-label="选择回收站模型 ${esc(m.model)}"></td>
    <td><code>${esc(m.model)}</code></td><td>${esc(m.label||m.model)}</td><td>${esc(m.pickerMode||'—')}</td>
    <td><code>${esc(m.nativeRequestModel||'—')}</code><br><small>${esc(m.nativeResponseModel||'—')}</small></td>
    <td><code>${esc(m.chatTransportModel||'—')}</code><br><small>${esc(m.chatResponseModel||'—')}</small></td>
    <td>发现 ${Number(m.accountCount||0)} / 请求 ${Number(m.requestConfirmedAccountCount||0)} / 原生响应 ${Number(m.verifiedAccountCount||0)} / Chat锁定 ${Number(m.chatLockVerifiedAccountCount||0)}</td>
    <td>${esc(fmt(m.deletedAt))}</td><td><button data-action="restore">还原</button></td>
  </tr>`).join('')||'<tr><td colspan="9" class="muted">回收站为空。</td></tr>';
  syncSelection();
}
async function load(){try{const data=await api('/admin/api/account/model-catalog');el.login.hidden=true;el.app.hidden=false;el.logout.hidden=false;render(data);el.loginMessage.textContent='';}catch(e){if(e.status===401){el.login.hidden=false;el.app.hidden=true;el.logout.hidden=true;}else el.loginMessage.textContent=e.message;}}
async function deleteModels(models){
  if(!models.length)return;
  if(!confirm(`确认删除勾选的 ${models.length} 个模型？模型及其账户证据会移入回收站，活动目录会立即提升代次。`))return;
  const data=await api('/admin/api/account/model-catalog',{method:'DELETE',body:JSON.stringify({models})});
  render(data);const missing=Array.isArray(data.missing)?data.missing.length:0;
  el.message.textContent=`已删除 ${Number(data.deleted?.length||0)} 个模型并移入回收站${missing?`，${missing} 个已不在活动目录`:''}。`;
}
async function restoreModels(models){
  if(!models.length)return;
  const data=await api('/admin/api/account/model-catalog/restore',{method:'POST',body:JSON.stringify({models})});
  render(data);const skipped=Array.isArray(data.skippedActive)?data.skippedActive.length:0;
  el.message.textContent=`已还原 ${Number(data.restored?.length||0)} 个模型${skipped?`，${skipped} 个因已被重新发现而保留在回收站`:''}。`;
}
el.loginButton.addEventListener('click',async()=>{try{await api('/admin/api/login',{method:'POST',body:JSON.stringify({password:el.password.value})});el.password.value='';await load();}catch(e){el.loginMessage.textContent=e.message;}});
el.password.addEventListener('keydown',(e)=>{if(e.key==='Enter')el.loginButton.click();});
el.logout.addEventListener('click',async()=>{await api('/admin/api/logout',{method:'POST',body:'{}'}).catch(()=>{});location.reload();});
el.refresh.addEventListener('click',()=>void load());
el.selectAll.addEventListener('change',()=>{el.body.querySelectorAll('input[data-select-model]').forEach((input)=>{input.checked=el.selectAll.checked;});syncSelection();});
el.selectAllTrash.addEventListener('change',()=>{el.trashBody.querySelectorAll('input[data-select-trash]').forEach((input)=>{input.checked=el.selectAllTrash.checked;});syncSelection();});
el.body.addEventListener('change',(e)=>{if(e.target.matches('input[data-select-model]'))syncSelection();});
el.trashBody.addEventListener('change',(e)=>{if(e.target.matches('input[data-select-trash]'))syncSelection();});
el.deleteSelected.addEventListener('click',async()=>{el.deleteSelected.disabled=true;el.message.textContent='';try{await deleteModels(selected(el.body,'input[data-select-model]:checked'));}catch(e){el.message.textContent=e.message;}finally{syncSelection();}});
el.restoreSelected.addEventListener('click',async()=>{el.restoreSelected.disabled=true;el.message.textContent='';try{await restoreModels(selected(el.trashBody,'input[data-select-trash]:checked'));}catch(e){el.message.textContent=e.message;}finally{syncSelection();}});
el.body.addEventListener('click',async(e)=>{const button=e.target.closest('button[data-action]');if(!button)return;const row=button.closest('tr[data-model]');if(!row)return;const model=row.dataset.model;button.disabled=true;el.message.textContent='';try{if(button.dataset.action==='delete')await deleteModels([model]);else{const label=row.querySelector('[data-field="label"]').value;const pickerMode=row.querySelector('[data-field="pickerMode"]').value||null;const enabled=row.querySelector('[data-field="enabled"]').checked;const data=await api('/admin/api/account/model-catalog',{method:'PUT',body:JSON.stringify({model,label,pickerMode,enabled})});render(data);el.message.textContent='模型设置已保存并提升目录代次。';}}catch(err){el.message.textContent=err.message;}finally{button.disabled=false;syncSelection();}});
el.trashBody.addEventListener('click',async(e)=>{const button=e.target.closest('button[data-action="restore"]');if(!button)return;const row=button.closest('tr[data-model]');if(!row)return;button.disabled=true;el.message.textContent='';try{await restoreModels([row.dataset.model]);}catch(err){el.message.textContent=err.message;}finally{button.disabled=false;syncSelection();}});
void load();
