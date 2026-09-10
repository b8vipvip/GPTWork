const $ = (id) => document.getElementById(id);
const el = {
  login: $('login'), app: $('app'), password: $('password'), loginButton: $('loginButton'), loginMessage: $('loginMessage'), logout: $('logout'),
  totalUsers: $('totalUsers'), verifiedUsers: $('verifiedUsers'), activeMemberships: $('activeMemberships'), pendingOrders: $('pendingOrders'),
  userSearch: $('userSearch'), refreshUsers: $('refreshUsers'), usersBody: $('usersBody'),
  createUserToggle: $('createUserToggle'), createUserPanel: $('createUserPanel'), cancelCreateUser: $('cancelCreateUser'),
  createUserEmail: $('createUserEmail'), createUserPassword: $('createUserPassword'), createUserEmailAccess: $('createUserEmailAccess'),
  createUserFreeDays: $('createUserFreeDays'), createUserDevices: $('createUserDevices'),
  generateUserPassword: $('generateUserPassword'), createUserSubmit: $('createUserSubmit'), createUserMessage: $('createUserMessage'),
  userPasswordDialog: $('userPasswordDialog'), userPasswordTarget: $('userPasswordTarget'), userPasswordNew: $('userPasswordNew'),
  userPasswordConfirm: $('userPasswordConfirm'), userPasswordMessage: $('userPasswordMessage'), userPasswordClose: $('userPasswordClose'),
  userPasswordCancel: $('userPasswordCancel'), userPasswordSubmit: $('userPasswordSubmit'),
  planCards: $('planCards'), refreshOrders: $('refreshOrders'), ordersBody: $('ordersBody'),
  freeDays: $('freeDays'), freeDevices: $('freeDevices'), sessionDays: $('sessionDays'),
  emailVerificationRequired: $('emailVerificationRequired'),
  smtpHost: $('smtpHost'),
  smtpPort: $('smtpPort'), smtpSecure: $('smtpSecure'), smtpUsername: $('smtpUsername'), smtpPassword: $('smtpPassword'), smtpFromEmail: $('smtpFromEmail'), smtpFromName: $('smtpFromName'), testEmail: $('testEmail'), sendTestEmail: $('sendTestEmail'), smtpState: $('smtpState'),
  wechatEnabled: $('wechatEnabled'), wechatUrl: $('wechatUrl'), wechatInstructions: $('wechatInstructions'),
  alipayEnabled: $('alipayEnabled'), alipayUrl: $('alipayUrl'), alipayInstructions: $('alipayInstructions'), saveSettings: $('saveSettings'), settingsMessage: $('settingsMessage'),
  runtimeLog: $('runtimeLog'), refreshRuntime: $('refreshRuntime'), exportRuntime: $('exportRuntime'), audit: $('audit'),
  updateButton: $('updateButton'), serverVersion: $('serverVersion'), currentCommit: $('currentCommit'), targetRef: $('targetRef'), updateProgress: $('updateProgress'), updatePercent: $('updatePercent'), updateMessage: $('updateMessage'), updateWarning: $('updateWarning'), updateLog: $('updateLog'),
};

const ACTIVE_UPDATE_STATES = new Set(['queued', 'running', 'restarting', 'rolling_back']);
let updatePoll = null;
let updateWasActive = false;
let plansCache = [];

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = body.error?.code || null;
    throw error;
  }
  return body;
}

function text(value) { return String(value ?? ''); }
function localDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
function localDateInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
function money(cents) { return `¥${(Number(cents || 0) / 100).toFixed(2)}`; }
function shortCommit(value) { return value ? String(value).slice(0, 12) : '—'; }
function setMessage(node, value, tone = '') {
  if (!node) return;
  node.textContent = value || '';
  node.className = `message ${tone}`.trim();
}
function td(value, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text(value);
  if (className) cell.className = className;
  return cell;
}
function button(label, handler, className = '') {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  if (className) node.className = className;
  node.addEventListener('click', handler);
  return node;
}
function inputControl(type, value = '', attributes = {}) {
  const node = document.createElement('input');
  node.type = type; node.value = value ?? '';
  for (const [key, attributeValue] of Object.entries(attributes)) {
    if (attributeValue !== null && attributeValue !== undefined) node.setAttribute(key, String(attributeValue));
  }
  return node;
}
function selectControl(options, selected) {
  const node = document.createElement('select');
  for (const [value, label] of options) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = value === selected; node.append(option);
  }
  return node;
}
function armInlineConfirm(node, label = '再次点击确认') {
  const now = Date.now();
  if (Number(node.dataset.confirmUntil || 0) > now) {
    node.dataset.confirmUntil = '0';
    return true;
  }
  const original = node.textContent;
  node.dataset.confirmUntil = String(now + 4000);
  node.textContent = label;
  setTimeout(() => {
    if (Number(node.dataset.confirmUntil || 0) <= Date.now()) { node.textContent = original; node.dataset.confirmUntil = '0'; }
  }, 4100);
  return false;
}

function renderDashboard(data) {
  const stats = data.stats || {};
  el.totalUsers.textContent = stats.totalUsers ?? 0;
  el.verifiedUsers.textContent = stats.verifiedUsers ?? 0;
  el.activeMemberships.textContent = stats.activeMemberships ?? 0;
  el.pendingOrders.textContent = stats.pendingOrders ?? 0;
}

function accountTier(row) {
  if (row.membership?.name) return row.membership.name;
  if (row.entitlement?.source === 'free') return '免费期';
  return '无有效权益';
}

function generateStrongPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%_-';
  const random = new Uint32Array(20);
  crypto.getRandomValues(random);
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
  if (open) {
    setMessage(el.createUserMessage, '');
    el.createUserEmail.focus();
  }
}

async function createUser() {
  const email = el.createUserEmail.value.trim();
  const password = el.createUserPassword.value;
  if (!email) throw new Error('请输入用户邮箱');
  if (password.length < 10) throw new Error('初始密码至少 10 位');
  const freeDays = Number(el.createUserFreeDays.value);
  if (!Number.isInteger(freeDays) || freeDays < 0 || freeDays > 3650) throw new Error('免费天数必须是 0–3650 的整数');
  const body = {
    email, password, emailAccess: el.createUserEmailAccess.value, freeDays,
    maxDevicesOverride: optionalPositiveInt(el.createUserDevices, '设备上限'),
  };
  const result = await api('/admin/api/account/users', { method: 'POST', body: JSON.stringify(body) });
  setMessage(el.createUserMessage, `用户 ${result.user?.email || email} 创建成功。请妥善保存初始密码。`, 'good');
  el.createUserEmail.value = '';
  el.createUserDevices.value = '';
  await loadUsers();
}

async function saveUserRow(row, controls, messageNode) {
  const email = controls.email.value.trim();
  if (!email) throw new Error('邮箱不能为空');
  let entitlementExpiresAt = null;
  if (controls.expiry.value) {
    const date = new Date(controls.expiry.value);
    if (Number.isNaN(date.getTime())) throw new Error('有效期格式无效');
    entitlementExpiresAt = date.toISOString();
  } else if (row.membership) {
    throw new Error('当前是会员权益，会员有效期不能为空');
  }
  const body = {
    email,
    status: controls.status.value,
    entitlementExpiresAt,
    maxDevicesOverride: optionalPositiveInt(controls.devices, '设备上限'),
    maxWindowsOverride: row.overrides?.windows ?? null,
  };
  setMessage(messageNode, '正在保存…');
  await api(`/admin/api/account/users/${row.id}`, { method: 'PATCH', body: JSON.stringify(body) });
  setMessage(messageNode, '用户信息与权益已保存。', 'good');
  await loadUsers();
}

async function grantMembership(row, planCode, messageNode) {
  const plan = plansCache.find((item) => item.enabled && item.code === planCode);
  if (!plan) throw new Error('请选择有效会员套餐');
  setMessage(messageNode, `正在为 ${row.email} 开通 ${plan.name}…`);
  await api(`/admin/api/account/users/${row.id}/grant-membership`, { method: 'POST', body: JSON.stringify({ planCode: plan.code }) });
  setMessage(messageNode, `${plan.name} 已开通/续期。`, 'good');
  await loadUsers();
}

async function resetDevices(row, messageNode) {
  setMessage(messageNode, '正在重置设备…');
  await api(`/admin/api/account/users/${row.id}/reset-devices`, { method: 'POST', body: '{}' });
  setMessage(messageNode, '设备绑定与登录会话已清空。', 'good');
  await loadUsers();
}

function openUserPasswordDialog(row) {
  el.userPasswordDialog.dataset.userId = String(row.id);
  el.userPasswordTarget.textContent = `${row.email} · 用户 #${row.id}`;
  el.userPasswordNew.value = '';
  el.userPasswordConfirm.value = '';
  setMessage(el.userPasswordMessage, '');
  el.userPasswordDialog.showModal();
  el.userPasswordNew.focus();
}

function closeUserPasswordDialog() {
  if (el.userPasswordDialog.open) el.userPasswordDialog.close();
  el.userPasswordDialog.dataset.userId = '';
  el.userPasswordNew.value = '';
  el.userPasswordConfirm.value = '';
  setMessage(el.userPasswordMessage, '');
}

async function submitUserPassword() {
  const userId = Number(el.userPasswordDialog.dataset.userId);
  const password = el.userPasswordNew.value;
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('用户记录无效，请关闭后重试');
  if (password.length < 10 || password.length > 128) throw new Error('新密码必须为 10–128 位');
  if (password !== el.userPasswordConfirm.value) throw new Error('两次输入的新密码不一致');
  el.userPasswordSubmit.disabled = true;
  setMessage(el.userPasswordMessage, '正在安全更新密码并注销旧会话…');
  try {
    await api(`/admin/api/account/users/${userId}/password`, { method: 'POST', body: JSON.stringify({ password }) });
    setMessage(el.userPasswordMessage, '密码已修改，旧登录会话已全部失效。', 'good');
    el.userPasswordNew.value = '';
    el.userPasswordConfirm.value = '';
    setTimeout(closeUserPasswordDialog, 900);
  } finally {
    el.userPasswordSubmit.disabled = false;
  }
}

function renderUsers(rows) {
  el.usersBody.textContent = '';
  const enabledPlans = plansCache.filter((plan) => plan.enabled);
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.append(td(row.id));

    const emailCell = document.createElement('td');
    const email = inputControl('email', row.email, { autocomplete: 'off', 'aria-label': `用户 ${row.id} 邮箱` });
    email.className = 'user-email-input'; emailCell.append(email); tr.append(emailCell);

    const statusCell = document.createElement('td');
    const status = selectControl([['active', '启用'], ['pending', '待验证'], ['disabled', '停用']], row.status);
    status.className = 'user-status-select'; statusCell.append(status);
    const verification = document.createElement('small'); verification.className = (row.emailVerified || row.emailVerificationExempt) ? 'tone-good' : 'tone-wait';
    verification.textContent = row.emailVerified ? '邮箱已验证' : (row.emailVerificationExempt ? '免邮箱验证' : '邮箱未验证');
    statusCell.append(document.createElement('br'), verification); tr.append(statusCell);

    const entitlementCell = document.createElement('td');
    const entitlement = document.createElement('div'); entitlement.className = 'entitlement-editor';
    const tier = document.createElement('strong'); tier.textContent = accountTier(row);
    const planRow = document.createElement('div'); planRow.className = 'compact-edit';
    const planSelect = selectControl(enabledPlans.map((plan) => [plan.code, plan.name]), row.membership?.planCode || enabledPlans[0]?.code || '');
    const rowMessage = document.createElement('span'); rowMessage.className = 'row-message';
    const grant = button(row.membership ? '续期' : '开通', () => {
      if (!armInlineConfirm(grant, '再次点击确认')) return;
      grant.disabled = true;
      void grantMembership(row, planSelect.value, rowMessage).catch((error) => setMessage(rowMessage, error.message, 'bad')).finally(() => { grant.disabled = false; });
    }, 'primary');
    if (!enabledPlans.length) { planSelect.disabled = true; grant.disabled = true; }
    planRow.append(planSelect, grant);
    const tierNote = document.createElement('small'); tierNote.textContent = row.membership ? `当前会员 #${row.membership.id}` : (row.entitlement?.source === 'free' ? '当前使用免费权益' : '当前无有效权益');
    entitlement.append(tier, planRow, tierNote); entitlementCell.append(entitlement); tr.append(entitlementCell);

    const devicesCell = document.createElement('td'); const devicesWrap = document.createElement('div'); devicesWrap.className = 'limit-editor';
    const devices = inputControl('number', row.overrides?.devices ?? '', { min: 1, max: 1000, placeholder: '默认' });
    const devicesUsage = document.createElement('small'); devicesUsage.textContent = `已用 ${row.entitlement?.usage?.devices ?? 0} / 生效 ${row.entitlement?.limits?.devices ?? 0}`;
    devicesWrap.append(devices, devicesUsage); devicesCell.append(devicesWrap); tr.append(devicesCell);

    const expiryCell = document.createElement('td'); const expiryWrap = document.createElement('div'); expiryWrap.className = 'expiry-editor';
    const expiry = inputControl('datetime-local', localDateInput(row.entitlement?.expiresAt));
    const expiryNote = document.createElement('small'); expiryNote.textContent = row.membership ? '修改当前会员到期时间' : '修改免费权益到期时间';
    expiryWrap.append(expiry, expiryNote); expiryCell.append(expiryWrap); tr.append(expiryCell);

    const actions = document.createElement('td'); actions.className = 'row-actions user-actions';
    const save = button('保存信息/权益', () => {
      save.disabled = true;
      void saveUserRow(row, { email, status, devices, expiry }, rowMessage)
        .catch((error) => setMessage(rowMessage, error.message, 'bad')).finally(() => { save.disabled = false; });
    }, 'primary');
    const password = button('修改密码', () => openUserPasswordDialog(row));
    const reset = button('重置设备', () => {
      if (!armInlineConfirm(reset, '再次点击重置')) return;
      reset.disabled = true;
      void resetDevices(row, rowMessage).catch((error) => setMessage(rowMessage, error.message, 'bad')).finally(() => { reset.disabled = false; });
    }, 'danger');
    actions.append(save, password, reset, rowMessage);
    tr.append(actions);
    el.usersBody.append(tr);
  }
  if (!rows.length) {
    const tr = document.createElement('tr');
    const cell = td('没有匹配用户'); cell.colSpan = 7; cell.className = 'empty'; tr.append(cell); el.usersBody.append(tr);
  }
}

async function loadUsers() {
  const q = el.userSearch.value.trim();
  const data = await api(`/admin/api/account/users?limit=500${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  renderUsers(data.users || []);
}

function planCard(plan) {
  const card = document.createElement('article'); card.className = 'plan-card';
  const isNormal = plan.code === 'normal';
  const head = document.createElement('div'); head.className = 'plan-head';
  const title = document.createElement('div');
  const name = document.createElement('input'); name.value = plan.name; name.readOnly = isNormal; name.setAttribute('aria-label', '用户等级名称');
  const code = document.createElement('small'); code.textContent = plan.code;
  title.append(name, code); head.append(title);
  const grid = document.createElement('div'); grid.className = 'plan-fields';
  const makeField = (labelText, value, min = 0) => {
    const label = document.createElement('label'); label.textContent = labelText;
    const input = document.createElement('input'); input.type = 'number'; input.min = String(min); input.value = String(value ?? '');
    label.append(input); grid.append(label); return input;
  };
  let originalPrice = null; let promoPrice = null; let promoEnd = null; let enabled = { checked: true };
  if (!isNormal) {
    originalPrice = makeField('升级价格（元）', ((plan.originalPriceCents ?? plan.priceCents) / 100).toFixed(2), 0); originalPrice.step = '0.01';
    promoPrice = makeField('促销价（元，可选）', plan.promoPriceCents == null ? '' : (plan.promoPriceCents / 100).toFixed(2), 0); promoPrice.step = '0.01';
    const promoEndLabel = document.createElement('label'); promoEndLabel.textContent = '促销结束时间（可选）';
    promoEnd = document.createElement('input'); promoEnd.type = 'datetime-local'; promoEnd.value = localDateInput(plan.promoEndsAt); promoEndLabel.append(promoEnd); grid.append(promoEndLabel);
    const enabledLabel = document.createElement('label'); enabledLabel.className = 'check compact'; enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(plan.enabled); enabledLabel.append(enabled, document.createTextNode(' 允许付费升级')); head.append(enabledLabel);
  }
  const days = makeField(isNormal ? '新用户初始有效天数' : '升级后有效天数', plan.durationDays, isNormal ? 0 : 1);
  const devices = makeField('设备上限', plan.limits.devices, 1);
  const windows = makeField('同时窗口上限', plan.limits.windows, 1);
  const benefitsLabel = document.createElement('label'); benefitsLabel.className = 'benefit-field'; benefitsLabel.textContent = '权益说明（每行一条）';
  const benefits = document.createElement('textarea'); benefits.rows = 5; benefits.value = (plan.benefits || []).join('
'); benefits.disabled = isNormal; benefitsLabel.append(benefits);
  const save = button('保存等级配置', async () => {
    save.disabled = true;
    try {
      const originalPriceCents = isNormal ? 0 : Math.round(Number(originalPrice.value) * 100);
      const promoPriceCents = isNormal || promoPrice.value.trim() === '' ? null : Math.round(Number(promoPrice.value) * 100);
      const promoEndsAt = isNormal || !promoEnd.value ? null : new Date(promoEnd.value).toISOString();
      if (!Number.isInteger(originalPriceCents) || originalPriceCents < 0) throw new Error('升级价格格式无效');
      if (promoPriceCents !== null && (!Number.isInteger(promoPriceCents) || promoPriceCents < 0 || promoPriceCents >= originalPriceCents)) throw new Error('促销价必须低于升级价格');
      await api(`/admin/api/account/plans/${encodeURIComponent(plan.code)}`, {
        method: 'PUT', body: JSON.stringify({
          name: name.value.trim(), priceCents: originalPriceCents, originalPriceCents, promoPriceCents, promoEndsAt,
          durationDays: Number(days.value), maxDevices: Number(devices.value), maxWindows: Number(windows.value),
          benefits: benefits.value.split(/?
/).map((item) => item.trim()).filter(Boolean), enabled: enabled.checked,
        }),
      });
      save.textContent = '已保存'; setTimeout(() => { save.textContent = '保存等级配置'; }, 1000); await loadPlans();
    } catch (error) { alert(error.message); } finally { save.disabled = false; }
  }, 'primary');
  card.append(head, grid, benefitsLabel, save); return card;
}

function renderPlans(plans) {
  plansCache = plans;
  if (!el.planCards) return;
  el.planCards.textContent = '';
  for (const plan of plans) el.planCards.append(planCard(plan));
}

async function loadPlans() {
  const data = await api('/admin/api/account/plans');
  renderPlans(data.plans || []);
}

function orderStatus(row) {
  return ({ pending: '待支付', paid: '已支付', cancelled: '已取消', expired: '已过期' })[row.status] || row.status;
}

async function markOrderPaid(row) {
  if (!confirm(`确认订单 #${row.id} 已到账，并为 ${row.email} 开通 ${row.planName}？`)) return;
  await api(`/admin/api/account/orders/${row.id}/mark-paid`, { method: 'POST', body: '{}' });
  await loadOrders();
}
async function cancelOrder(row) {
  if (!confirm(`确认取消订单 #${row.id}？`)) return;
  await api(`/admin/api/account/orders/${row.id}/cancel`, { method: 'POST', body: '{}' });
  await loadOrders();
}

function renderOrders(rows) {
  el.ordersBody.textContent = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.append(td(`#${row.id}`), td(row.email), td(row.planName || row.planCode), td(row.paymentName || row.paymentMethod), td(money(row.amountCents)), td(orderStatus(row)), td(localDate(row.createdAt)));
    const actions = document.createElement('td'); actions.className = 'row-actions';
    if (row.status === 'pending') actions.append(button('确认到账', () => void markOrderPaid(row), 'primary'), button('取消', () => void cancelOrder(row), 'danger'));
    else actions.textContent = '—';
    tr.append(actions); el.ordersBody.append(tr);
  }
  if (!rows.length) {
    const tr = document.createElement('tr'); const cell = td('暂无订单'); cell.colSpan = 8; cell.className = 'empty'; tr.append(cell); el.ordersBody.append(tr);
  }
}

async function loadOrders() {
  const data = await api('/admin/api/account/orders');
  renderOrders(data.orders || []);
}

function methodByCode(settings, code) {
  return (settings.paymentMethods || []).find((item) => item.code === code) || { code, enabled: false, payUrl: '', instructions: '' };
}

function renderSettings(data) {
  const settings = data.settings || {};
  el.freeDays.value = settings.free?.days ?? 7;
  el.freeDevices.value = settings.free?.maxDevices ?? 1;
  el.sessionDays.value = settings.sessionDays ?? 30;
  el.emailVerificationRequired.checked = settings.emailVerificationRequired !== false;
  if (el.createUserFreeDays && !el.createUserFreeDays.value) el.createUserFreeDays.value = settings.free?.days ?? 7;
  const smtp = settings.smtp || {};
  el.smtpHost.value = smtp.host || '';
  el.smtpPort.value = smtp.port || 465;
  el.smtpSecure.checked = smtp.secure !== false;
  el.smtpUsername.value = smtp.username || '';
  el.smtpPassword.value = '';
  el.smtpFromEmail.value = smtp.fromEmail || '';
  el.smtpFromName.value = smtp.fromName || 'GPTWork';
  el.smtpState.textContent = smtp.passwordConfigured ? 'SMTP 密码/授权码已加密保存；密码框留空不会覆盖。' : '尚未保存 SMTP 密码/授权码。';
  const wechat = methodByCode(settings, 'wechat');
  el.wechatEnabled.checked = Boolean(wechat.enabled); el.wechatUrl.value = wechat.payUrl || ''; el.wechatInstructions.value = wechat.instructions || '';
  const alipay = methodByCode(settings, 'alipay');
  el.alipayEnabled.checked = Boolean(alipay.enabled); el.alipayUrl.value = alipay.payUrl || ''; el.alipayInstructions.value = alipay.instructions || '';
}

async function loadSettings() {
  renderSettings(await api('/admin/api/account/settings'));
}

async function saveSettings() {
  setMessage(el.settingsMessage, '正在保存…');
  const body = {
    free: { days: Number(el.freeDays.value), maxDevices: Number(el.freeDevices.value) },
    sessionDays: Number(el.sessionDays.value),
    emailVerificationRequired: el.emailVerificationRequired.checked,
    smtp: {
      host: el.smtpHost.value.trim(), port: Number(el.smtpPort.value), secure: el.smtpSecure.checked, username: el.smtpUsername.value.trim(),
      fromEmail: el.smtpFromEmail.value.trim(), fromName: el.smtpFromName.value.trim(),
      ...(el.smtpPassword.value ? { password: el.smtpPassword.value } : {}),
    },
    paymentMethods: [
      { code: 'wechat', enabled: el.wechatEnabled.checked, payUrl: el.wechatUrl.value.trim(), instructions: el.wechatInstructions.value.trim() },
      { code: 'alipay', enabled: el.alipayEnabled.checked, payUrl: el.alipayUrl.value.trim(), instructions: el.alipayInstructions.value.trim() },
    ],
  };
  const data = await api('/admin/api/account/settings', { method: 'PUT', body: JSON.stringify(body) });
  el.smtpPassword.value = '';
  renderSettings(data);
  setMessage(el.settingsMessage, '配置已保存。客户端下次刷新账户配置时生效。', 'good');
}

async function sendTestEmail() {
  const email = el.testEmail.value.trim();
  if (!email) return setMessage(el.settingsMessage, '请输入测试收件邮箱。', 'bad');
  el.sendTestEmail.disabled = true;
  try {
    await api('/admin/api/account/settings/test-email', { method: 'POST', body: JSON.stringify({ email }) });
    setMessage(el.settingsMessage, `测试邮件已提交发送至 ${email}。`, 'good');
  } catch (error) { setMessage(el.settingsMessage, `测试邮件失败：${error.message}`, 'bad'); }
  finally { el.sendTestEmail.disabled = false; }
}

function formatRuntimeEntry(entry) {
  const detail = entry?.detail && Object.keys(entry.detail).length ? ` ${JSON.stringify(entry.detail)}` : '';
  return `${entry?.timestamp || '—'}  ${(entry?.level || 'info').toUpperCase().padEnd(5)}  ${entry?.event || 'event'}${detail}`;
}
async function loadRuntimeLogs() {
  try {
    const data = await api('/admin/api/runtime-logs?limit=400');
    const rows = Array.isArray(data.logs) ? data.logs : [];
    el.runtimeLog.textContent = rows.length ? rows.map(formatRuntimeEntry).join('\n') : '暂无服务端运行日志';
    el.runtimeLog.scrollTop = el.runtimeLog.scrollHeight;
  } catch (error) { el.runtimeLog.textContent = `运行日志读取失败：${error.message}`; }
}
async function loadAudit() {
  try {
    const data = await api('/admin/api/account/audit');
    el.audit.textContent = (data.audit || []).map((row) => `${row.created_at}  ${row.event}  user#${row.user_id ?? '-'}  ${row.detail}`).join('\n') || '暂无账户审计';
  } catch (error) { el.audit.textContent = `审计读取失败：${error.message}`; }
}
async function exportRuntimeLogs() {
  const original = el.exportRuntime.textContent;
  try {
    el.exportRuntime.disabled = true; el.exportRuntime.textContent = '导出中…';
    const response = await fetch('/admin/api/runtime-logs/export', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] || `gptlock-server-runtime-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  } catch (error) { alert(`导出运行日志失败：${error.message}`); }
  finally { el.exportRuntime.disabled = false; el.exportRuntime.textContent = original; }
}

function renderUpdate(data) {
  const status = data.status || {};
  const active = ACTIVE_UPDATE_STATES.has(status.status);
  const percent = Math.max(0, Math.min(100, Number(status.percent || 0)));
  el.serverVersion.textContent = data.serverVersion || 'unknown';
  el.currentCommit.textContent = shortCommit(data.currentCommit); el.currentCommit.title = data.currentCommit || '';
  el.targetRef.textContent = data.targetRef || 'main';
  el.updateProgress.style.width = `${percent}%`; el.updatePercent.textContent = `${percent}%`;
  el.updateMessage.textContent = status.message || '尚未执行版本更新';
  el.updateLog.textContent = Array.isArray(data.log) && data.log.length ? data.log.join('\n') : '暂无更新日志'; el.updateLog.scrollTop = el.updateLog.scrollHeight;
  el.updateButton.disabled = active || !data.updaterReady; el.updateButton.textContent = active ? '正在更新…' : '版本更新';
  el.updateWarning.hidden = data.updaterReady; el.updateWarning.textContent = data.updaterReady ? '' : '系统更新器尚未安装，请先安装 updater systemd 单元。';
  if (status.status === 'failed' && status.error) { el.updateWarning.hidden = false; el.updateWarning.textContent = `更新失败：${status.error}`; }
  if (updateWasActive && !active && status.status === 'succeeded') el.updateMessage.textContent = `${status.message || '更新完成'}，后台已切换到新版本。`;
  updateWasActive = active;
}
async function loadUpdate() {
  try { renderUpdate(await api('/admin/api/update')); }
  catch (error) {
    if (!el.app.hidden) { el.updateMessage.textContent = '服务正在重启，等待重新连接…'; el.updateWarning.hidden = false; el.updateWarning.textContent = error.message; }
  }
}
function startUpdatePolling() { if (!updatePoll) updatePoll = setInterval(() => void loadUpdate(), 1000); }
function stopUpdatePolling() { if (updatePoll) { clearInterval(updatePoll); updatePoll = null; } }

async function loadDashboard() { renderDashboard(await api('/admin/api/account/dashboard')); }

async function loadAll() {
  try {
    const page = document.body.dataset.adminPage || 'overview';
    const dashboard = await api('/admin/api/account/dashboard');
    el.login.hidden = true; el.app.hidden = false; el.logout.hidden = false;
    if (page === 'overview') renderDashboard(dashboard);
    else if (page === 'users') { await loadPlans(); await loadUsers(); }
    else if (page === 'plans') await loadPlans();
    else if (page === 'orders') await loadOrders();
    else if (page === 'settings') await loadSettings();
    else if (page === 'server-logs') await Promise.all([loadRuntimeLogs(), loadAudit()]);
    else if (page === 'update') { await loadUpdate(); startUpdatePolling(); }
    // client-logs is loaded by client-runtime-admin.js after #app becomes visible.
  } catch (error) {
    if (error.status === 401) {
      stopUpdatePolling(); el.app.hidden = true; el.login.hidden = false; el.logout.hidden = true;
    } else if (!el.app.hidden) {
      setMessage(el.loginMessage, error.message, 'bad');
    }
  }
}

el.loginButton.addEventListener('click', async () => {
  try {
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: el.password.value }) });
    el.password.value = ''; setMessage(el.loginMessage, ''); await loadAll();
  } catch (error) { setMessage(el.loginMessage, error.message, 'bad'); }
});
el.password.addEventListener('keydown', (event) => { if (event.key === 'Enter') el.loginButton.click(); });
el.logout.addEventListener('click', async () => { stopUpdatePolling(); await api('/admin/api/logout', { method: 'POST', body: '{}' }).catch(() => {}); location.reload(); });
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
  void submitUserPassword().catch((error) => setMessage(el.userPasswordMessage, error.message, 'bad'));
});
el.userPasswordConfirm?.addEventListener('keydown', (event) => { if (event.key === 'Enter') el.userPasswordSubmit.click(); });
el.refreshOrders?.addEventListener('click', () => void loadOrders());
el.saveSettings?.addEventListener('click', () => {
  el.saveSettings.disabled = true;
  void saveSettings().catch((error) => setMessage(el.settingsMessage, error.message, 'bad')).finally(() => { el.saveSettings.disabled = false; });
});
el.sendTestEmail?.addEventListener('click', () => void sendTestEmail());
el.refreshRuntime?.addEventListener('click', () => void Promise.all([loadRuntimeLogs(), loadAudit()]));
el.exportRuntime?.addEventListener('click', () => void exportRuntimeLogs());
el.updateButton?.addEventListener('click', async () => {
  try {
    el.updateButton.disabled = true; el.updateButton.textContent = '正在提交…';
    await api('/admin/api/update', { method: 'POST', body: '{}' }); updateWasActive = true; await loadUpdate(); startUpdatePolling();
  } catch (error) { el.updateWarning.hidden = false; el.updateWarning.textContent = error.message; el.updateButton.disabled = false; el.updateButton.textContent = '版本更新'; }
});

void loadAll();
