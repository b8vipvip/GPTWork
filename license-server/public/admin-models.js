const $=(id)=>document.getElementById(id);
const el={login:$('login'),app:$('app'),password:$('password'),loginButton:$('loginButton'),loginMessage:$('loginMessage'),logout:$('logout'),body:$('modelsBody'),refresh:$('refreshModels'),generation:$('generation'),message:$('modelsMessage')};

async function api(path,options={}){
  const response=await fetch(path,{credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json',...(options.headers||{})},...options});
  const body=await response.json().catch(()=>({}));
  if(!response.ok||body.ok===false){const e=new Error(body?.error?.message||'请求失败');e.status=response.status;throw e;}
  return body;
}
function esc(value){return String(value??'').replace(/[&<>"']/g,(ch)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function fmt(value){if(!value)return '—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString();}
function render(data){
  const models=Array.isArray(data.models)?data.models:[];
  el.generation.textContent=`目录代次 ${Number(data.generation||0)} · ${models.length} 个模型`;
  el.body.innerHTML=models.map((m)=>`<tr data-model="${esc(m.model)}">
    <td><code>${esc(m.model)}</code></td>
    <td><input data-field="label" value="${esc(m.label||m.model)}" maxlength="120"></td>
    <td><select data-field="pickerMode"><option value="">—</option><option value="A" ${m.pickerMode==='A'?'selected':''}>A</option><option value="B" ${m.pickerMode==='B'?'selected':''}>B</option></select></td>
    <td><code>${esc(m.nativeRequestModel||'—')}</code><br><small>${esc(m.nativeResponseModel||'—')}</small></td>
    <td><code>${esc(m.chatTransportModel||'—')}</code><br><small>${esc(m.chatResponseModel||'—')}</small></td>
    <td>${Number(m.chatLockVerifiedCount||0)>0?'✅':'—'} (${Number(m.chatLockVerifiedCount||0)})</td>
    <td><input data-field="enabled" type="checkbox" ${m.enabled!==false?'checked':''}></td>
    <td>发现 ${Number(m.accountCount||0)} / 原生响应 ${Number(m.verifiedAccountCount||0)} / Chat锁定 ${Number(m.chatLockVerifiedAccountCount||0)}</td>
    <td>${Number(m.discoveredCount||0)}</td>
    <td>${esc(fmt(m.lastSeenAt))}</td>
    <td><button data-action="save">保存</button> <button data-action="delete" class="danger">删除</button></td>
  </tr>`).join('')||'<tr><td colspan="11" class="muted">尚未收到客户端上传的模型。</td></tr>';
}
async function load(){
  try{
    const data=await api('/admin/api/account/model-catalog');
    el.login.hidden=true;el.app.hidden=false;el.logout.hidden=false;render(data);el.loginMessage.textContent='';
  }catch(e){
    if(e.status===401){el.login.hidden=false;el.app.hidden=true;el.logout.hidden=true;}
    else el.loginMessage.textContent=e.message;
  }
}
el.loginButton.addEventListener('click',async()=>{try{await api('/admin/api/login',{method:'POST',body:JSON.stringify({password:el.password.value})});el.password.value='';await load();}catch(e){el.loginMessage.textContent=e.message;}});
el.password.addEventListener('keydown',(e)=>{if(e.key==='Enter')el.loginButton.click();});
el.logout.addEventListener('click',async()=>{await api('/admin/api/logout',{method:'POST',body:'{}'}).catch(()=>{});location.reload();});
el.refresh.addEventListener('click',()=>void load());
el.body.addEventListener('click',async(e)=>{
  const button=e.target.closest('button[data-action]');if(!button)return;
  const row=button.closest('tr[data-model]');if(!row)return;
  const model=row.dataset.model;button.disabled=true;el.message.textContent='';
  try{
    if(button.dataset.action==='delete'){
      if(!confirm(`确认删除模型 ${model}？删除后会提升目录代次并同步到客户端。`))return;
      const data=await api('/admin/api/account/model-catalog',{method:'DELETE',body:JSON.stringify({model})});render(data);el.message.textContent='模型已删除，客户端将在下一次控制同步时更新目录。';
    }else{
      const label=row.querySelector('[data-field="label"]').value;
      const pickerMode=row.querySelector('[data-field="pickerMode"]').value||null;
      const enabled=row.querySelector('[data-field="enabled"]').checked;
      const data=await api('/admin/api/account/model-catalog',{method:'PUT',body:JSON.stringify({model,label,pickerMode,enabled})});render(data);el.message.textContent='模型设置已保存并提升目录代次。';
    }
  }catch(err){el.message.textContent=err.message;}finally{button.disabled=false;}
});
void load();
