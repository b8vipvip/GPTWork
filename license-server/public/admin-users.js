const $ = (id) => document.getElementById(id);
const el = {
  login: $('login'), app: $('app'), password: $('password'), loginButton: $('loginButton'), loginMessage: $('loginMessage'), logout: $('logout'),
  userSearch: $('userSearch'), refreshUsers: $('refreshUsers'), usersBody: $('usersBody'),
  createUserToggle: $('createUserToggle'), createUserPanel: $('createUserPanel'), cancelCreateUser: $('cancelCreateUser'),
  createUserEmail: $('createUserEmail'), createUserPassword: $('createUserPassword'), createUserEmailAccess: $('createUserEmailAccess'),
  createUserFreeDays: $('createUserFreeDays'), createUserDevices: $('createUserDevices'), generateUserPassword: $('generateUserPassword'),
  createUserSubmit: $('createUserSubmit'), createUserMessage: $('createUserMessage'),
  userPasswordDialog: $('userPasswordDialog'), userPasswordTarget: $('userPasswordTarget'), userPasswordNew: $('userPasswordNew'),
  userPasswordConfirm: $('userPasswordConfirm'), userPasswordMessage: $('userPasswordMessage'), userPasswordClose: $('userPasswordClose'),
  userPasswordCancel: $('userPasswordCancel'), userPasswordSubmit: $('userPasswordSubmit'),
  userEditDialog: $('userEditDialog'), userEditTitle: $('userEditTitle'), userEditTarget: $('userEditTarget'), userEditBody: $('userEditBody'),
  userEditMessage: $('userEditMessage'), userEditClose: $('userEditClose'), userEditCancel: $('userEditCancel'), userEditSubmit: $('userEditSubmit'),
};

let plansCache = [];
let usersCache = [];
let clientStatusByUser = new Map();
let activeEditor = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}
function setMessage(node, value, tone = '') {
  if (!node) return;
  node.textContent = value || '';
  node.className = `message ${tone}`.trim();
}
function td(value = '') {
  const node = document.createElement('td');
  node.textContent = String(value ?? '');
  return node;
}
function button(label, handler, className = '') {
  const node = document.createElement('button');
  node.type = 'button'; node.textContent = label;
  if (className) node.className = className;
  node.addEventListener('click', handler);
  return node;
}
function iconButton(label, title, handler) {
  const node = button(label, handler, 'user-icon-button');
  node.title = title; node.setAttribute('aria-label', title);
  node.style.border = '0'; node.style.background = 'transparent'; node.style.padding = '2px 4px'; node.style.fontSize = '15px'; node.style.boxShadow = 'none';
  return node;
}
function selectControl(options, selected) {
  const node = document.createElement('select');
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value; option.textContent = label; option.selected = value === selected; node.append(option);
  }
  return node;
}
function field(labelText, control) {
  const label = document.createElement('label');
  label.textContent = labelText; label.append(control); return label;
}
function localDateInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
function remainingDays(value) {
  const expires = Date.parse(value || '');
  if (!Number.isFinite(expires)) return null;
  return Math.max(0, Math.ceil((expires - Date.now()) / (24 * 60 * 60 * 1000)));
}
function accountTier(row) {
  return row.level?.name || row.entitlement?.level?.name || '普通用户';
}
function statusLabel(value) {
  return ({ active: '启用', pending: '待验证', disabled: '停用' })[value] || value || '—';
}
function armInlineConfirm(node, label = '再次点击确认') {
  const now = Date.now();
  if (Number(node.dataset.confirmUntil || 0) > now) { node.dataset.confirmUntil = '0'; return true; }
  const original = node.textContent;
  node.dataset.confirmUntil = String(now + 4000); node.textContent = label;
  setTimeout(() => {
    if (Number(node.dataset.confirmUntil || 0) <= Date.now()) { node.textContent = original; node.dataset.confirmUntil = '0'; }
  }, 4100);
  return false;
}
function generateStrongPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%_-';
  const random = new Uint32Array(20); crypto.getRandomValues(random);
  return Array.from(random, (value) => alphabet[value % alphabet.length]).join('');
}
function optionalPositiveInt(input, label) {
  const raw = input.value.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Error(`${label}必须是 1–1000 的整数`);
  return value;
}
function setCreateUserPanel(open) {
  el.createUserPanel.hidden = !open;
  if (open) { setMessage(el.createUserMessage, ''); el.createUserEmail.focus(); }
}
async function createUser() {
  const email = el.createUserEmail.value.trim();
  const password = el.createUserPassword.value;
  const freeDays = Number(el.createUserFreeDays.value);
  if (!email) throw new Error('请输入用户邮箱');
  if (password.length < 10) throw new Error('初始密码至少 10 位');
  if (!Number.isInteger(freeDays) || freeDays < 0 || freeDays > 3650) throw new Error('免费天数必须是 0–3650 的整数');
  const result = await api('/admin/api/account/users', {
    method: 'POST', body: JSON.stringify({
      email, password, emailAccess: el.createUserEmailAccess.value, freeDays,
      maxDevicesOverride: optionalPositiveInt(el.createUserDevices, '设备上限'),
    }),
  });
  setMessage(el.createUserMessage, `用户 ${result.user?.email || email} 创建成功。请妥善保存初始密码。`, 'good');
  el.createUserEmail.value = ''; el.createUserDevices.value = '';
  await loadUsers();
}
function fullUserPatch(row, extra = {}) {
  return {
    email: row.email,
    status: row.status,
    maxDevicesOverride: row.overrides?.devices ?? null,
    maxWindowsOverride: row.overrides?.windows ?? null,
    ...extra,
  };
}
async function patchUser(row, patch) {
  await api(`/admin/api/account/users/${row.id}`, { method: 'PATCH', body: JSON.stringify(fullUserPatch(row, patch)) });
  await loadUsers();
}

function openEditor(row, kind) {
  activeEditor = { row, kind, controls: {} };
  el.userEditBody.textContent = '';
  el.userEditTitle.textContent = ({ email: '编辑邮箱', status: '设置账户状态', devices: '设置设备上限', entitlement: '设置用户等级' })[kind] || '编辑用户';
  el.userEditTarget.textContent = `${row.email} · 用户 #${row.id}`;
  setMessage(el.userEditMessage, '');

  if (kind === 'email') {
    const input = document.createElement('input'); input.type = 'email'; input.value = row.email; input.autocomplete = 'off';
    activeEditor.controls.email = input; el.userEditBody.append(field('邮箱', input));
  } else if (kind === 'status') {
    const select = selectControl([['active', '启用'], ['pending', '待验证'], ['disabled', '停用']], row.status);
    activeEditor.controls.status = select; el.userEditBody.append(field('账户状态', select));
  } else if (kind === 'devices') {
    const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = '1000'; input.placeholder = '留空 = 跟随用户等级'; input.value = row.overrides?.devices ?? '';
    activeEditor.controls.devices = input; el.userEditBody.append(field('自定义设备上限', input));
    const note = document.createElement('p'); note.className = 'dialog-note'; note.textContent = `当前已用 ${row.entitlement?.usage?.devices ?? 0} 台，当前生效上限 ${row.entitlement?.limits?.devices ?? 0} 台。`;
    el.userEditBody.append(note);
  } else if (kind === 'entitlement') {
    const levels = plansCache.filter((item) => ['normal', 'deep', 'heavy'].includes(item.code));
    const level = selectControl(levels.map((item) => [item.code, item.name]), row.level?.code || row.entitlement?.level?.code || 'normal');
    const expiry = document.createElement('input'); expiry.type = 'datetime-local'; expiry.value = localDateInput(row.entitlement?.expiresAt);
    activeEditor.controls.level = level; activeEditor.controls.expiry = expiry;
    el.userEditBody.append(field('用户等级', level), field('权益有效期', expiry));
    const note = document.createElement('p'); note.className = 'dialog-note';
    note.textContent = '等级决定设备/窗口上限；权益有效期决定当前账号还能使用多久。管理员可直接调整等级。';
    el.userEditBody.append(note);
  }
  el.userEditDialog.showModal();
  el.userEditBody.querySelector('input,select')?.focus();
}
function closeEditor() {
  if (el.userEditDialog.open) el.userEditDialog.close();
  activeEditor = null; el.userEditBody.textContent = ''; setMessage(el.userEditMessage, '');
}
async function saveEditor() {
  if (!activeEditor) return;
  const { row, kind, controls } = activeEditor;
  if (kind === 'email') {
    const email = controls.email.value.trim(); if (!email) throw new Error('邮箱不能为空');
    await patchUser(row, { email });
  } else if (kind === 'status') {
    await patchUser(row, { status: controls.status.value });
  } else if (kind === 'devices') {
    await patchUser(row, { maxDevicesOverride: optionalPositiveInt(controls.devices, '设备上限') });
  } else if (kind === 'entitlement') {
    const expiry = controls.expiry.value ? new Date(controls.expiry.value) : null;
    if (expiry && Number.isNaN(expiry.getTime())) throw new Error('权益有效期格式无效');
    await patchUser(row, { userLevel: controls.level.value, entitlementExpiresAt: expiry ? expiry.toISOString() : null });
  }
  closeEditor();
}

function openUserPasswordDialog(row) {
  el.userPasswordDialog.dataset.userId = String(row.id);
  el.userPasswordTarget.textContent = `${row.email} · 用户 #${row.id}`;
  el.userPasswordNew.value = ''; el.userPasswordConfirm.value = ''; setMessage(el.userPasswordMessage, '');
  el.userPasswordDialog.showModal(); el.userPasswordNew.focus();
}
function closeUserPasswordDialog() {
  if (el.userPasswordDialog.open) el.userPasswordDialog.close();
  el.userPasswordDialog.dataset.userId = ''; el.userPasswordNew.value = ''; el.userPasswordConfirm.value = ''; setMessage(el.userPasswordMessage, '');
}
async function submitUserPassword() {
  const userId = Number(el.userPasswordDialog.dataset.userId);
  const password = el.userPasswordNew.value;
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('用户记录无效，请关闭后重试');
  if (password.length < 10 || password.length > 128) throw new Error('新密码必须为 10–128 位');
  if (password !== el.userPasswordConfirm.value) throw new Error('两次输入的新密码不一致');
  await api(`/admin/api/account/users/${userId}/password`, { method: 'POST', body: JSON.stringify({ password }) });
  setMessage(el.userPasswordMessage, '密码已修改，旧登录会话已全部失效。', 'good');
  el.userPasswordNew.value = ''; el.userPasswordConfirm.value = ''; setTimeout(closeUserPasswordDialog, 900);
}
async function queueClientUpdate(row, status, messageNode, buttonNode) {
  buttonNode.disabled = true;
  try {
    const data = await api(`/admin/api/client-control/users/${row.id}/update`, { method: 'POST', body: '{}' });
    const online = Boolean(data.user?.online ?? status?.online);
    setMessage(messageNode, online ? '已触发在线客户端更新。' : '更新任务已排队，将在客户端下次上线时执行。', 'good');
    await loadUsers();
  } finally { buttonNode.disabled = false; }
}
async function resetAccount(row, messageNode, buttonNode) {
  if (!armInlineConfirm(buttonNode, '再次点击重置')) return;
  buttonNode.disabled = true; setMessage(messageNode, '正在重置账户权益并下发同步任务…');
  try {
    await api(`/admin/api/client-control/users/${row.id}/reset-account`, { method: 'POST', body: '{}' });
    setMessage(messageNode, '账户已恢复为注册时初始权益；在线客户端将立即同步，离线客户端下次上线同步。', 'good');
    await loadUsers();
  } finally { buttonNode.disabled = false; }
}

function renderUsers(rows) {
  el.usersBody.textContent = '';
  for (const row of rows) {
    const status = clientStatusByUser.get(Number(row.id)) || {};
    const tr = document.createElement('tr'); tr.append(td(row.id));

    const emailCell = td('');
    const emailWrap = document.createElement('span'); emailWrap.textContent = row.email;
    emailCell.append(emailWrap, iconButton('✎', `编辑 ${row.email} 的邮箱`, () => openEditor(row, 'email'))); tr.append(emailCell);

    const statusCell = td('');
    const statusWrap = document.createElement('span'); statusWrap.textContent = statusLabel(row.status);
    statusCell.append(statusWrap, iconButton('⚙', `设置 ${row.email} 的账户状态`, () => openEditor(row, 'status')));
    const verification = document.createElement('small'); verification.style.display = 'block'; verification.style.marginTop = '4px';
    verification.className = (row.emailVerified || row.emailVerificationExempt) ? 'tone-good' : 'tone-wait';
    verification.textContent = row.emailVerified ? '邮箱已验证' : (row.emailVerificationExempt ? '免邮箱验证' : '邮箱未验证'); statusCell.append(verification); tr.append(statusCell);

    const entitlementCell = td('');
    const tier = document.createElement('strong'); tier.textContent = accountTier(row);
    const days = remainingDays(row.entitlement?.expiresAt);
    const remaining = document.createElement('small'); remaining.style.display = 'block'; remaining.style.marginTop = '4px'; remaining.style.color = '#64748b';
    remaining.textContent = days === null ? '剩余天数 —' : `剩余 ${days} 天`;
    entitlementCell.append(tier, iconButton('⚙', `设置 ${row.email} 的用户等级`, () => openEditor(row, 'entitlement')), remaining); tr.append(entitlementCell);

    const devicesCell = td('');
    const deviceText = document.createElement('span');
    deviceText.textContent = row.overrides?.devices ?? `默认（生效 ${row.entitlement?.limits?.devices ?? 0}）`;
    const usage = document.createElement('small'); usage.style.display = 'block'; usage.style.marginTop = '4px'; usage.style.color = '#64748b'; usage.textContent = `已用 ${row.entitlement?.usage?.devices ?? 0} 台`;
    devicesCell.append(deviceText, iconButton('⚙', `设置 ${row.email} 的设备上限`, () => openEditor(row, 'devices')), usage); tr.append(devicesCell);

    const versionCell = td('');
    const version = document.createElement('span'); version.textContent = status.clientVersion || '—';
    const update = button('更新', () => {}, 'primary');
    const rowMessage = document.createElement('span'); rowMessage.className = 'row-message';
    update.onclick = () => void queueClientUpdate(row, status, rowMessage, update).catch((error) => setMessage(rowMessage, error.message, 'bad'));
    versionCell.append(version, document.createTextNode(' '), update); tr.append(versionCell);

    const onlineCell = td('');
    const online = document.createElement('strong'); online.textContent = status.online ? '在线' : '离线'; online.className = status.online ? 'tone-good' : 'tone-wait';
    const onlineNote = document.createElement('small'); onlineNote.style.display = 'block'; onlineNote.style.marginTop = '4px'; onlineNote.style.color = '#64748b';
    onlineNote.textContent = `登录设备 ${status.loggedInDevices ?? 0} · 在线设备 ${status.onlineDevices ?? 0}`;
    onlineCell.append(online, onlineNote); tr.append(onlineCell);

    const actions = td(''); actions.className = 'row-actions user-actions';
    const password = button('修改密码', () => openUserPasswordDialog(row));
    const reset = button('重置账户', () => {}, 'danger');
    reset.onclick = () => void resetAccount(row, rowMessage, reset).catch((error) => setMessage(rowMessage, error.message, 'bad'));
    actions.append(password, reset, rowMessage); tr.append(actions);
    el.usersBody.append(tr);
  }
  if (!rows.length) {
    const tr = document.createElement('tr'); const cell = td('没有匹配用户'); cell.colSpan = 8; cell.className = 'empty'; tr.append(cell); el.usersBody.append(tr);
  }
}
async function loadPlans() {
  const data = await api('/admin/api/account/plans'); plansCache = data.plans || [];
}
async function loadUsers() {
  const q = el.userSearch.value.trim();
  const [users, clients] = await Promise.all([
    api(`/admin/api/account/users?limit=500${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    api('/admin/api/client-control/users'),
  ]);
  usersCache = users.users || [];
  clientStatusByUser = new Map((clients.users || []).map((row) => [Number(row.userId), row]));
  renderUsers(usersCache);
}
async function loadDefaults() {
  try {
    const data = await api('/admin/api/account/settings');
    if (el.createUserFreeDays && !el.createUserFreeDays.value) el.createUserFreeDays.value = data.settings?.free?.days ?? 7;
  } catch {}
}
async function loadAll() {
  try {
    await api('/admin/api/account/dashboard');
    el.login.hidden = true; el.app.hidden = false; el.logout.hidden = false;
    await Promise.all([loadPlans(), loadDefaults()]); await loadUsers();
  } catch (error) {
    if (error.status === 401) { el.app.hidden = true; el.login.hidden = false; el.logout.hidden = true; }
    else setMessage(el.loginMessage, error.message, 'bad');
  }
}

el.loginButton.addEventListener('click', async () => {
  try {
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: el.password.value }) });
    el.password.value = ''; setMessage(el.loginMessage, ''); await loadAll();
  } catch (error) { setMessage(el.loginMessage, error.message, 'bad'); }
});
el.password.addEventListener('keydown', (event) => { if (event.key === 'Enter') el.loginButton.click(); });
el.logout.addEventListener('click', async () => { await api('/admin/api/logout', { method: 'POST', body: '{}' }).catch(() => {}); location.reload(); });
el.refreshUsers?.addEventListener('click', () => void loadUsers());
el.userSearch?.addEventListener('keydown', (event) => { if (event.key === 'Enter') void loadUsers(); });
el.createUserToggle?.addEventListener('click', () => setCreateUserPanel(el.createUserPanel.hidden));
el.cancelCreateUser?.addEventListener('click', () => setCreateUserPanel(false));
el.generateUserPassword?.addEventListener('click', () => { el.createUserPassword.value = generateStrongPassword(); el.createUserPassword.type = 'text'; setTimeout(() => { el.createUserPassword.type = 'password'; }, 5000); });
el.createUserSubmit?.addEventListener('click', () => {
  el.createUserSubmit.disabled = true;
  void createUser().catch((error) => setMessage(el.createUserMessage, error.message, 'bad')).finally(() => { el.createUserSubmit.disabled = false; });
});
el.userPasswordClose?.addEventListener('click', closeUserPasswordDialog);
el.userPasswordCancel?.addEventListener('click', closeUserPasswordDialog);
el.userPasswordDialog?.addEventListener('cancel', (event) => { event.preventDefault(); closeUserPasswordDialog(); });
el.userPasswordSubmit?.addEventListener('click', () => {
  el.userPasswordSubmit.disabled = true;
  void submitUserPassword().catch((error) => setMessage(el.userPasswordMessage, error.message, 'bad')).finally(() => { el.userPasswordSubmit.disabled = false; });
});
el.userPasswordConfirm?.addEventListener('keydown', (event) => { if (event.key === 'Enter') el.userPasswordSubmit.click(); });
el.userEditClose?.addEventListener('click', closeEditor);
el.userEditCancel?.addEventListener('click', closeEditor);
el.userEditDialog?.addEventListener('cancel', (event) => { event.preventDefault(); closeEditor(); });
el.userEditSubmit?.addEventListener('click', () => {
  el.userEditSubmit.disabled = true; setMessage(el.userEditMessage, '正在保存…');
  void saveEditor().catch((error) => setMessage(el.userEditMessage, error.message, 'bad')).finally(() => { el.userEditSubmit.disabled = false; });
});

void loadAll();
