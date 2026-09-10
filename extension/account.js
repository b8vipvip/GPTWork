const $ = (id) => document.getElementById(id);
const el = {
  notLogged: $('notLogged'), app: $('app'), refresh: $('refresh'), email: $('email'), statusBadge: $('statusBadge'), tier: $('tier'), expiry: $('expiry'),
  deviceUsage: $('deviceUsage'), windowUsage: $('windowUsage'), levelExpiry: $('levelExpiry'), plans: $('plans'), orderMessage: $('orderMessage'), upgradeButton: $('upgradeButton'), upgradeDialog: $('upgradeDialog'), upgradeClose: $('upgradeClose'),
  devices: $('devices'), sessions: $('sessions'), revokeOtherSessions: $('revokeOtherSessions'), securityMessage: $('securityMessage'),
  passwordForm: $('passwordForm'), currentPassword: $('currentPassword'), newPassword: $('newPassword'), newPassword2: $('newPassword2'), passwordMessage: $('passwordMessage'),
};

let account = null;
let config = null;
let security = { devices: [], sessions: [] };

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      if (!response?.ok) return reject(Object.assign(new Error(response?.error || '请求失败'), { code: response?.code, status: response?.status, details: response?.details }));
      resolve(response.data);
    });
  });
}

function localDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
function money(cents) { return `¥${(Number(cents || 0) / 100).toFixed(2)}`; }
function message(node, text, tone = '') { node.textContent = text || ''; node.className = `message ${tone}`.trim(); }

function renderPlans() {
  el.plans.textContent = '';
  const methods = Array.isArray(config?.paymentMethods) ? config.paymentMethods : [];
  const currentRank = Number(account?.level?.rank ?? account?.entitlement?.level?.rank ?? 0);
  const plans = (config?.plans || []).filter((plan) => ({ deep: 1, heavy: 2 }[plan.code] ?? 0) > currentRank);
  if (!plans.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '当前已经是最高用户等级。'; el.plans.append(empty); return;
  }
  for (const plan of plans) {
    const card = document.createElement('article'); card.className = 'plan';
    const title = document.createElement('h3'); title.textContent = plan.name;
    const price = document.createElement('div'); price.className = 'price'; price.textContent = money(plan.priceCents);
    const small = document.createElement('small'); small.textContent = ` / ${plan.durationDays} 天`; price.append(small);
    const benefits = document.createElement('ul'); benefits.className = 'benefits';
    for (const item of plan.benefits || []) { const li = document.createElement('li'); li.textContent = item; benefits.append(li); }
    const limit = document.createElement('p'); limit.className = 'muted'; limit.textContent = `设备 ${plan.limits.devices} · 同时窗口 ${plan.limits.windows}`;
    const payRow = document.createElement('div'); payRow.className = 'pay-row';
    if (!methods.length) {
      const disabled = document.createElement('button'); disabled.disabled = true; disabled.textContent = '支付方式暂未配置'; payRow.append(disabled);
    } else {
      for (const method of methods) {
        const button = document.createElement('button'); button.className = 'primary'; button.textContent = `${method.name}升级`;
        button.addEventListener('click', () => void createOrder(plan, method, button)); payRow.append(button);
      }
    }
    card.append(title, price, limit, benefits, payRow); el.plans.append(card);
  }
}

function renderSecurity() {
  el.devices.textContent = '';
  for (const device of security.devices || []) {
    const row = document.createElement('article'); row.className = 'security-row';
    const copy = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = device.platform || '未知设备';
    if (device.current) { const badge = document.createElement('span'); badge.className = 'mini-badge'; badge.textContent = '当前设备'; title.append(' ', badge); }
    const meta = document.createElement('p'); meta.textContent = `首次 ${localDate(device.firstSeenAt)} · 最后 ${localDate(device.lastSeenAt)} · 活跃会话 ${device.activeSessions || 0}`;
    copy.append(title, meta); row.append(copy);
    const action = document.createElement('button');
    if (device.current) { action.textContent = '当前设备'; action.disabled = true; }
    else { action.textContent = '释放设备'; action.addEventListener('click', () => void releaseDevice(device, action)); }
    row.append(action); el.devices.append(row);
  }
  if (!(security.devices || []).length) el.devices.textContent = '暂无已绑定设备';

  el.sessions.textContent = '';
  let otherSessions = 0;
  for (const session of security.sessions || []) {
    const row = document.createElement('article'); row.className = 'security-row';
    const copy = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = session.platform || '未知会话';
    if (session.current) { const badge = document.createElement('span'); badge.className = 'mini-badge'; badge.textContent = '当前会话'; title.append(' ', badge); }
    const meta = document.createElement('p'); meta.textContent = `GPTWork ${session.extensionVersion || '—'} · 最后 ${localDate(session.lastSeenAt)} · 到期 ${localDate(session.expiresAt)}`;
    copy.append(title, meta); row.append(copy);
    const action = document.createElement('button');
    if (session.current) { action.textContent = '当前会话'; action.disabled = true; }
    else { otherSessions += 1; action.textContent = '退出会话'; action.addEventListener('click', () => void revokeSession(session, action)); }
    row.append(action); el.sessions.append(row);
  }
  if (!(security.sessions || []).length) el.sessions.textContent = '暂无活跃登录会话';
  el.revokeOtherSessions.disabled = otherSessions === 0;
}

function renderAccount() {
  const authenticated = Boolean(account?.authenticated);
  el.notLogged.hidden = authenticated;
  el.app.hidden = !authenticated;
  if (!authenticated) return;
  const user = account.user || {};
  const entitlement = account.entitlement || {};
  el.email.textContent = user.email || '—';
  el.statusBadge.textContent = entitlement.active ? '权益有效' : '权益已到期';
  el.statusBadge.className = `badge ${entitlement.active ? 'good' : 'bad'}`;
  el.tier.textContent = account.level?.name || entitlement.level?.name || '普通用户';
  el.expiry.textContent = `权益有效期至 ${localDate(entitlement.expiresAt)}`;
  el.deviceUsage.textContent = `${entitlement.usage?.devices ?? 0} / ${entitlement.limits?.devices ?? 0}`;
  el.windowUsage.textContent = `${entitlement.usage?.windows ?? 0} / ${entitlement.limits?.windows ?? 0}`;
  el.levelExpiry.textContent = localDate(entitlement.expiresAt);
  renderPlans();
  renderSecurity();
}

async function load() {
  try {
    const [state, remoteConfig] = await Promise.all([
      sendMessage({ type: 'GPTLOCK_GET_STATE' }),
      sendMessage({ type: 'GPTLOCK_ACCOUNT_CONFIG' }),
    ]);
    account = state.account || { authenticated: false };
    config = remoteConfig;
    security = account.authenticated
      ? (await sendMessage({ type: 'GPTLOCK_ACCOUNT_SECURITY' })).security || { devices: [], sessions: [] }
      : { devices: [], sessions: [] };
    renderAccount();
  } catch (error) {
    message(el.orderMessage, error.message, 'bad');
  }
}

async function releaseDevice(device, button) {
  if (device.current || !confirm(`确认释放设备“${device.platform || '未知设备'}”？该设备上的 GPTWork 登录会话会立即失效。`)) return;
  const original = button.textContent; button.disabled = true; button.textContent = '释放中…';
  try {
    const data = await sendMessage({ type: 'GPTLOCK_ACCOUNT_RELEASE_DEVICE', deviceRecordId: device.id });
    security = data.security || security;
    message(el.securityMessage, '旧设备已释放，设备额度已立即腾出。', 'good');
    await load();
  } catch (error) { message(el.securityMessage, `释放失败：${error.message}`, 'bad'); }
  finally { button.disabled = false; button.textContent = original; }
}

async function revokeSession(session, button) {
  if (session.current || !confirm('确认退出这个 GPTWork 登录会话？')) return;
  const original = button.textContent; button.disabled = true; button.textContent = '退出中…';
  try {
    const data = await sendMessage({ type: 'GPTLOCK_ACCOUNT_REVOKE_SESSION', sessionId: session.id });
    security = data.security || security;
    message(el.securityMessage, '登录会话已注销。', 'good');
    await load();
  } catch (error) { message(el.securityMessage, `退出失败：${error.message}`, 'bad'); }
  finally { button.disabled = false; button.textContent = original; }
}

async function createOrder(plan, method, button) {
  const original = button.textContent;
  button.disabled = true; button.textContent = '创建订单…';
  try {
    const data = await sendMessage({ type: 'GPTLOCK_ACCOUNT_CREATE_ORDER', planCode: plan.code, paymentMethod: method.code });
    const order = data.order;
    message(el.orderMessage, `订单 #${order.id} 已创建，金额 ${money(order.amountCents)}。${data.instructions || ''}`, 'good');
    if (order.payUrl) await chrome.tabs.create({ url: order.payUrl });
    else message(el.orderMessage, `订单 #${order.id} 已创建，但管理员尚未配置该支付方式的 HTTPS 支付页面。`, 'bad');
  } catch (error) {
    message(el.orderMessage, `创建订单失败：${error.message}`, 'bad');
  } finally {
    button.disabled = false; button.textContent = original;
  }
}

el.revokeOtherSessions.addEventListener('click', () => {
  if (!confirm('确认退出除当前会话外的全部 GPTWork 登录会话？')) return;
  el.revokeOtherSessions.disabled = true;
  message(el.securityMessage, '正在退出其它会话…');
  void sendMessage({ type: 'GPTLOCK_ACCOUNT_REVOKE_OTHER_SESSIONS' })
    .then(async (data) => {
      security = data.security || security;
      message(el.securityMessage, `已退出 ${data.revokedCount || 0} 个其它会话。`, 'good');
      await load();
    })
    .catch((error) => message(el.securityMessage, `操作失败：${error.message}`, 'bad'))
    .finally(() => { el.revokeOtherSessions.disabled = false; renderSecurity(); });
});

el.passwordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (el.newPassword.value !== el.newPassword2.value) { message(el.passwordMessage, '两次新密码不一致。', 'bad'); return; }
  message(el.passwordMessage, '正在修改密码…');
  void sendMessage({ type: 'GPTLOCK_ACCOUNT_CHANGE_PASSWORD', currentPassword: el.currentPassword.value, newPassword: el.newPassword.value })
    .then(() => {
      el.currentPassword.value = ''; el.newPassword.value = ''; el.newPassword2.value = '';
      message(el.passwordMessage, '密码已修改，其他登录会话已失效。', 'good');
    })
    .catch((error) => message(el.passwordMessage, `修改失败：${error.message}`, 'bad'));
});

el.upgradeButton?.addEventListener('click', () => { renderPlans(); el.upgradeDialog?.showModal(); });
el.upgradeClose?.addEventListener('click', () => el.upgradeDialog?.close());
el.upgradeDialog?.addEventListener('click', (event) => { if (event.target === el.upgradeDialog) el.upgradeDialog.close(); });
el.refresh.addEventListener('click', () => void load());
void load().then(() => { if (location.hash === '#upgrade' && account?.authenticated) { renderPlans(); el.upgradeDialog?.showModal(); } });
