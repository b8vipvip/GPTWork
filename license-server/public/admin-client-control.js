const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), enabled: $('clientAutoUpdateEnabled'), sync: $('syncClientVersions'),
  generation: $('clientUpdateGeneration'), state: $('clientUpdateState'), message: $('clientUpdateConfigMessage'),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body;
}
function message(value, tone = '') {
  if (!el.message) return;
  el.message.textContent = value || '';
  el.message.className = `message ${tone}`.trim();
}
function render(config = {}) {
  if (el.enabled) el.enabled.checked = config.autoUpdateEnabled !== false;
  if (el.generation) el.generation.textContent = String(config.syncGeneration ?? 0);
  if (el.state) {
    el.state.textContent = config.autoUpdateEnabled !== false ? '已启用' : '已停用';
    el.state.className = config.autoUpdateEnabled !== false ? 'tone-good' : 'tone-wait';
  }
}
async function load() {
  if (!el.app || el.app.hidden) return;
  const data = await api('/admin/api/client-control'); render(data.config);
}
async function saveEnabled() {
  const desired = Boolean(el.enabled.checked);
  el.enabled.disabled = true; message('正在保存客户端更新策略…');
  try {
    const data = await api('/admin/api/client-control', { method: 'PUT', body: JSON.stringify({ autoUpdateEnabled: desired }) });
    render(data.config);
    message(desired
      ? '已启用：客户端会接收正式版通知并自动更新。'
      : '已停用：客户端不会接收自动新版本通知，也不会自动更新。管理员手动“同步客户端版本”仍可强制下发一次更新任务。', 'good');
  } catch (error) {
    el.enabled.checked = !desired; message(error.message, 'bad');
  } finally { el.enabled.disabled = false; }
}
async function syncAll() {
  el.sync.disabled = true; message('正在为全部现有用户下发客户端版本同步任务…');
  try {
    const data = await api('/admin/api/client-control/sync-all', { method: 'POST', body: '{}' });
    render(data.queued);
    const online = Number(data.queued?.onlineUsers || 0);
    const offline = Number(data.queued?.offlineUsers || 0);
    message(`已下发：在线用户 ${online} 个将立即检查并更新；离线用户 ${offline} 个已排队，下次上线自动执行。`, 'good');
  } catch (error) { message(error.message, 'bad'); }
  finally { el.sync.disabled = false; }
}

el.enabled?.addEventListener('change', () => void saveEnabled());
el.sync?.addEventListener('click', () => void syncAll());

if (el.app) {
  const observer = new MutationObserver(() => { if (!el.app.hidden) void load().catch((error) => message(error.message, 'bad')); });
  observer.observe(el.app, { attributes: true, attributeFilter: ['hidden'] });
}
void load().catch(() => {});
