const state = {
  account: null,
  config: { plans: [], paymentMethods: [] },
  websiteConfig: null,
  paymentPoll: null,
  refreshTimer: null,
  promoTimer: null,
};

function text(value, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}
function dateText(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—';
}
function money(cents) { return `¥${(Number(cents || 0) / 100).toFixed(2)}`; }
function remainingText(endValue) {
  const ms = Date.parse(endValue || '') - Date.now();
  if (!(ms > 0)) return '活动已结束';
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return [days ? `${days}天` : '', `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`].filter(Boolean).join(' ');
}
function activePromo(plan) {
  return Boolean(plan?.promoActive && Number(plan?.promoPriceCents) < Number(plan?.originalPriceCents) && Date.parse(plan?.promoEndsAt || '') > Date.now());
}
function safeHttps(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch { return ''; }
}
function safeNavHref(value) {
  const href = String(value || '');
  if (/^\/(?!\/)[^\s]*$/.test(href)) return href;
  return safeHttps(href);
}
function node(tag, className = '', value = undefined) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = String(value);
  return element;
}
function setStyles(element, values) { Object.assign(element.style, values); return element; }
function setNotice(element, message, tone = '') {
  if (!element) return;
  element.textContent = message || '';
  element.className = `notice${tone ? ` ${tone}` : ''}${message ? '' : ' hidden'}`;
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data?.error?.message || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = data?.error?.code || '';
    throw error;
  }
  return data;
}

function levelRank(code) { return ({ normal: 0, deep: 1, heavy: 2 })[String(code || '')] ?? 0; }
function higherPlans() {
  const currentRank = Number(state.account?.level?.rank ?? levelRank(state.account?.level?.code));
  return (state.config.plans || []).filter((plan) => levelRank(plan.code) > currentRank);
}
function paymentMethodLabel(method) {
  if (method?.code === 'wechat') return '微信支付';
  if (method?.code === 'alipay') return '支付宝';
  if (method?.code === 'paypal') return 'PayPal';
  if (method?.code === 'usdt') return 'USDT';
  return method?.name || method?.code || '支付';
}

function setupMobileNavigation() {
  const nav = document.querySelector('.site-header .nav-links');
  const shell = nav?.closest('.nav');
  if (!nav || !shell || nav.dataset.mobileReady === '1') return;
  nav.dataset.mobileReady = '1';
  nav.id ||= 'siteNavigation';
  const toggle = node('button', 'nav-toggle', '菜单');
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', nav.id);
  toggle.setAttribute('aria-expanded', 'false');
  const close = () => { nav.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', () => {
    const open = !nav.classList.contains('is-open');
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', (event) => { if (event.target.closest('a')) close(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  shell.insertBefore(toggle, nav);
}

function applyWebsiteChrome(config) {
  state.websiteConfig = config || {};
  const site = state.websiteConfig.site || {};
  const brand = document.querySelector('.site-header .brand > span:last-child');
  if (brand && site.brandName) brand.textContent = site.brandName;
  const footer = document.querySelector('.site-footer .footer-row > span');
  if (footer && site.footerText) footer.textContent = site.footerText;
  const navigation = Array.isArray(state.websiteConfig.navigation)
    ? [...state.websiteConfig.navigation].filter((item) => item.enabled).sort((a, b) => Number(a.order) - Number(b.order))
    : null;
  const nav = document.querySelector('.site-header .nav-links');
  if (nav && navigation) {
    nav.replaceChildren();
    for (const item of navigation) {
      const href = safeNavHref(item.href);
      if (!href) continue;
      const link = node('a', item.account ? 'nav-account' : '', item.label || '链接');
      link.href = href;
      if (href.startsWith('https://') && !href.startsWith(location.origin)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      if ((new URL(href, location.origin)).pathname.replace(/\/$/, '') === '/account') link.setAttribute('aria-current', 'page');
      nav.append(link);
    }
  }
  const ordersModule = state.websiteConfig.pages?.account?.modules?.find((item) => item?.id === 'account-recent-orders');
  const recentOrders = document.getElementById('recentOrdersSection');
  if (recentOrders) {
    recentOrders.hidden = !Boolean(ordersModule?.enabled);
    recentOrders.setAttribute('aria-hidden', ordersModule?.enabled ? 'false' : 'true');
  }
  setupMobileNavigation();
}

function renderRewards(rewards) {
  const rewardSection = document.getElementById('rewardSection');
  const checkinButton = document.getElementById('dailyCheckin');
  const shareButton = document.getElementById('copyInvite');
  if (!rewards) {
    rewardSection?.classList.add('hidden');
    if (checkinButton) checkinButton.disabled = true;
    if (shareButton) shareButton.disabled = true;
    return;
  }
  rewardSection?.classList.remove('hidden');
  const checkin = rewards.checkin || {};
  const share = rewards.invite || {};
  const checkinState = document.getElementById('checkinState');
  if (checkinState) checkinState.textContent = checkin.checkedInToday
    ? `今日已签到 · 累计 ${Number(checkin.totalCheckins || 0)} 天`
    : `今日可签到 · 每次 +${Number(checkin.rewardDays || 1)} 天`;
  if (checkinButton) {
    checkinButton.disabled = Boolean(checkin.checkedInToday);
    checkinButton.textContent = checkin.checkedInToday ? '今日已签到' : `签到 +${Number(checkin.rewardDays || 1)}`;
  }
  const rewardExpiry = document.getElementById('rewardExpiry');
  if (rewardExpiry) rewardExpiry.textContent = dateText(rewards.bonusExpiresAt);
  const inviteCode = document.getElementById('inviteCode');
  if (inviteCode) inviteCode.textContent = share.code || '—';
  const inviteLink = document.getElementById('inviteLink');
  if (inviteLink) { inviteLink.value = share.url || ''; inviteLink.title = share.url || ''; }
  const inviteCount = document.getElementById('inviteCount');
  if (inviteCount) inviteCount.textContent = `${Number(share.successfulInvites || 0)} 人 · 每人 +${Number(share.rewardDays || 7)} 天`;
  if (shareButton) {
    shareButton.disabled = !share.url;
    shareButton.textContent = `分享 +${Number(share.rewardDays || 7)}`;
  }
}

function renderSecurity(data) {
  const deviceList = document.getElementById('deviceList');
  deviceList.replaceChildren();
  for (const device of data.security?.devices || []) {
    const row = node('div', 'list-row');
    const main = node('div', 'list-main');
    main.append(node('b', '', text(device.platform, '未知设备')), node('small', '', `最近活动 ${dateText(device.lastSeenAt)} · ${device.activeSessions || 0} 个插件会话`));
    const release = node('button', 'btn btn-small btn-soft', '释放设备');
    release.type = 'button';
    release.addEventListener('click', async () => {
      release.disabled = true;
      try { await api('/site/api/account/devices/release', { method: 'POST', body: JSON.stringify({ deviceRecordId: device.id }) }); await refreshAccount(); }
      catch (error) { setNotice(document.getElementById('securityNotice'), error.message, 'error'); }
      finally { release.disabled = false; }
    });
    row.append(main, release); deviceList.append(row);
  }
  if (!deviceList.childElementCount) deviceList.append(node('div', 'loading', '暂无已绑定设备'));

  const extensionList = document.getElementById('extensionSessionList');
  extensionList.replaceChildren();
  for (const session of data.security?.sessions || []) {
    const row = node('div', 'list-row');
    const main = node('div', 'list-main');
    main.append(node('b', '', `${text(session.platform, '未知平台')} · GPTWork ${text(session.extensionVersion, '未知版本')}`), node('small', '', `最近活动 ${dateText(session.lastSeenAt)}`));
    const revoke = node('button', 'btn btn-small btn-soft', '注销');
    revoke.type = 'button';
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      try { await api('/site/api/account/sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId: session.id }) }); await refreshAccount(); }
      finally { revoke.disabled = false; }
    });
    row.append(main, revoke); extensionList.append(row);
  }
  if (!extensionList.childElementCount) extensionList.append(node('div', 'loading', '当前没有活动的插件会话'));

  const siteList = document.getElementById('siteSessionList');
  siteList.replaceChildren();
  for (const session of data.security?.siteSessions || []) {
    const row = node('div', 'list-row');
    const main = node('div', 'list-main');
    main.append(node('b', '', session.current ? '当前网页登录' : '网页登录'), node('small', '', `${text(session.ip, '未知 IP')} · ${dateText(session.lastSeenAt)} · ${text(session.userAgent, '')}`));
    row.append(main);
    if (!session.current) {
      const revoke = node('button', 'btn btn-small btn-soft', '注销');
      revoke.type = 'button';
      revoke.addEventListener('click', async () => { await api('/site/api/account/site-sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId: session.id }) }); await refreshAccount(); });
      row.append(revoke);
    }
    siteList.append(row);
  }
  if (!siteList.childElementCount) siteList.append(node('div', 'loading', '暂无网页登录'));
}

function renderOrders(data) {
  const orderList = document.getElementById('orderList');
  if (!orderList) return;
  orderList.replaceChildren();
  for (const order of data.orders || []) {
    const row = node('div', 'list-row');
    const main = node('div', 'list-main');
    const amount = order.paymentMethod === 'usdt' && order.payment?.amount ? `${order.payment.amount} USDT` : money(order.amountCents);
    main.append(node('b', '', `#${order.id} · ${text(order.planSnapshot?.name, order.planCode)} · ${amount}`), node('small', '', `${text(order.status)} · ${dateText(order.createdAt)}`));
    row.append(main);
    const pay = safeHttps(order.payUrl);
    if (order.status === 'pending' && pay) {
      const link = node('a', 'btn btn-small btn-soft', '继续支付');
      link.href = pay; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link);
    }
    orderList.append(row);
  }
  if (!orderList.childElementCount) orderList.append(node('div', 'loading', '暂无订单'));
}

function renderUpgradePlans() {
  const root = document.getElementById('planList');
  if (!root) return;
  root.replaceChildren();
  const plans = higherPlans();
  const methods = state.config.paymentMethods || [];
  for (const plan of plans) {
    const card = node('article', 'plan');
    const price = node('div', 'plan-price');
    const current = node('span', '', money(plan.priceCents));
    setStyles(current, { color: '#dc2626', fontSize: '30px', fontWeight: '900', letterSpacing: '-.02em' });
    price.append(current);
    if (activePromo(plan)) {
      const original = node('span', '', `原价 ${money(plan.originalPriceCents)}`);
      setStyles(original, { color: '#94a3b8', fontSize: '13px', fontWeight: '600', textDecoration: 'line-through', marginLeft: '10px' });
      const save = node('span', '', `立省 ${money(plan.savingsCents)}`);
      setStyles(save, { color: '#b91c1c', fontSize: '12px', fontWeight: '800', background: '#fee2e2', borderRadius: '999px', padding: '4px 8px', marginLeft: '8px' });
      price.append(original, save);
      const countdown = node('div', '', `限时优惠 · 恢复原价剩余时间 ${remainingText(plan.promoEndsAt)}`);
      countdown.dataset.promoCountdown = plan.promoEndsAt;
      setStyles(countdown, { marginTop: '9px', color: '#991b1b', fontSize: '12px', fontWeight: '750' });
      price.after(countdown);
    }
    card.append(node('strong', '', plan.name), price, node('small', '', `${plan.durationDays} 天 · 设备 ${plan.limits?.devices ?? 1} · 同时窗口 ${plan.limits?.windows ?? 1}`));
    const benefits = node('ul');
    for (const benefit of plan.benefits || []) benefits.append(node('li', '', benefit));
    if (benefits.childElementCount) card.append(benefits);
    const actions = node('div', 'asset-row');
    if (!methods.length) {
      const disabled = node('button', 'btn btn-small btn-soft', '支付方式暂未配置');
      disabled.disabled = true;
      actions.append(disabled);
    } else {
      const select = document.createElement('select');
      select.className = 'payment-method-select';
      select.setAttribute('aria-label', `${plan.name}支付方式`);
      for (const method of methods) {
        const option = document.createElement('option');
        option.value = method.code;
        option.textContent = paymentMethodLabel(method);
        select.append(option);
      }
      const button = node('button', 'btn btn-small btn-primary', '开通');
      button.type = 'button';
      button.textContent = '开通';
      button.addEventListener('click', () => {
        const method = methods.find((item) => item.code === select.value) || methods[0];
        if (method) void createUpgradeOrder(plan, method, button);
      });
      actions.append(select, button);
    }
    card.append(actions); root.append(card);
  }
  if (!root.childElementCount) root.append(node('div', 'loading', '当前已经是最高用户等级'));
  const upgrade = document.getElementById('siteUpgrade');
  if (upgrade) {
    upgrade.hidden = plans.length === 0;
    upgrade.disabled = plans.length === 0 || state.config.plans.length === 0;
  }
}

function stopPaymentPoll() {
  if (state.paymentPoll) clearInterval(state.paymentPoll);
  state.paymentPoll = null;
}
function renderPaymentBox(result, method) {
  const box = document.getElementById('paymentBox');
  if (!box) return;
  box.className = 'notice good payment-box';
  box.replaceChildren();
  const order = result.order || result;
  box.append(node('strong', '', `订单 #${order.id} · ${paymentMethodLabel(method)}`));
  if (order.paymentMethod === 'usdt' && order.payment?.amount) box.append(node('div', 'plan-price', `${order.payment.amount} USDT`));
  if (result.instructions) box.append(node('p', '', result.instructions));
  const qr = safeHttps(order.payment?.qrImageUrl || method?.qrUrl);
  if (qr) {
    const image = document.createElement('img');
    image.src = qr;
    image.alt = `${paymentMethodLabel(method)}支付二维码`;
    image.className = 'payment-qr';
    box.append(image, node('div', '', `请使用${paymentMethodLabel(method)}扫码完成支付`));
  }
  const pay = safeHttps(order.payUrl || method?.payUrl);
  if (pay) {
    const link = node('a', 'btn btn-small btn-soft', '打开支付页面 →');
    link.href = pay; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(link);
  }
}
async function createUpgradeOrder(plan, method, button) {
  const original = button.textContent;
  button.disabled = true; button.textContent = '正在打开…';
  try {
    const result = await api('/site/api/account/orders', { method: 'POST', body: JSON.stringify({ planCode: plan.code, paymentMethod: method.code }) });
    renderPaymentBox(result, method);
    stopPaymentPoll();
    const orderId = result.order?.id;
    if (orderId) {
      state.paymentPoll = setInterval(async () => {
        try {
          const current = await api(`/site/api/account/orders/${encodeURIComponent(orderId)}`);
          if (current.order?.status === 'paid') {
            stopPaymentPoll();
            setNotice(document.getElementById('paymentBox'), '支付成功，用户等级与权益有效期已更新。', 'good');
            await refreshAccount();
          } else if (['expired', 'cancelled'].includes(current.order?.status)) {
            stopPaymentPoll();
            setNotice(document.getElementById('paymentBox'), current.order.status === 'expired' ? '订单已过期，请重新升级。' : '订单已取消。', 'error');
          }
        } catch {}
      }, 2000);
    }
  } catch (error) {
    setNotice(document.getElementById('paymentBox'), error.message, 'error');
  } finally { button.disabled = false; button.textContent = original; }
}

function renderAccount(data) {
  const account = data.account || {};
  const entitlement = account.entitlement || {};
  state.account = account;
  document.getElementById('accountEmail').textContent = text(account.user?.email);
  document.getElementById('entitlementSource').textContent = text(account.level?.name, '普通用户');
  document.getElementById('entitlementExpiry').textContent = dateText(entitlement.expiresAt);
  document.getElementById('deviceUsage').textContent = `${Number(entitlement.usage?.devices || 0)} / ${Number(entitlement.limits?.devices || 0)}`;
  renderRewards(data.rewards);
  renderSecurity(data);
  renderOrders(data);
  renderUpgradePlans();
}

async function loadUpgradeConfig() {
  try {
    const [accountConfig, paymentConfig] = await Promise.all([
      api('/api/v1/account/config'),
      api('/site/api/payments').catch(() => ({ paymentMethods: [] })),
    ]);
    state.config = {
      plans: Array.isArray(accountConfig.plans) ? accountConfig.plans : [],
      paymentMethods: paymentConfig.paymentMethods || accountConfig.paymentMethods || [],
    };
  } catch {
    state.config = { plans: [], paymentMethods: [] };
  }
}

async function refreshAccount() {
  const loading = document.getElementById('accountLoading');
  const guest = document.getElementById('accountGuest');
  const dashboard = document.getElementById('accountDashboard');
  const loginCard = document.getElementById('loginCard');
  loading?.classList.remove('hidden');
  try {
    const data = await api('/site/api/account/me');
    loading?.classList.add('hidden'); guest?.classList.add('hidden'); dashboard?.classList.remove('hidden'); loginCard?.classList.add('hidden');
    renderAccount(data);
    return true;
  } catch (error) {
    state.account = null;
    loading?.classList.add('hidden'); dashboard?.classList.add('hidden'); guest?.classList.remove('hidden'); loginCard?.classList.remove('hidden');
    if (error.status !== 401) setNotice(document.getElementById('loginNotice'), error.message, 'error');
    return false;
  }
}

function installActions() {
  document.getElementById('siteLogin')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const out = document.getElementById('loginNotice');
    setNotice(out, '正在登录…');
    try {
      await api('/site/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
      event.currentTarget.reset();
      setNotice(out, '登录成功', 'good');
      await refreshAccount();
    } catch (error) { setNotice(out, error.message, 'error'); }
  });
  document.getElementById('siteLogout')?.addEventListener('click', async () => {
    await api('/site/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
    location.reload();
  });
  document.getElementById('dailyCheckin')?.addEventListener('click', async () => {
    const button = document.getElementById('dailyCheckin');
    button.disabled = true;
    try {
      const data = await api('/site/api/account/checkin', { method: 'POST', body: '{}' });
      renderRewards(data.rewards);
      setNotice(document.getElementById('rewardNotice'), data.alreadyCheckedIn ? '今天已经签到过了。' : '签到成功，权益有效期已增加 1 天。', 'good');
      await refreshAccount();
    } catch (error) { setNotice(document.getElementById('rewardNotice'), `签到失败：${error.message}`, 'error'); }
  });
  document.getElementById('copyInvite')?.addEventListener('click', async () => {
    const value = document.getElementById('inviteLink')?.value || '';
    if (!value) return;
    try { await navigator.clipboard.writeText(value); setNotice(document.getElementById('rewardNotice'), '分享链接已复制。对方注册并登录该链接后，你将获得 7 天使用时长。', 'good'); }
    catch { document.getElementById('inviteLink')?.select(); setNotice(document.getElementById('rewardNotice'), '请复制已选中的分享链接。'); }
  });
  document.getElementById('siteUpgrade')?.addEventListener('click', () => {
    renderUpgradePlans(); document.getElementById('siteUpgradeDialog')?.showModal();
  });
  document.getElementById('siteUpgradeClose')?.addEventListener('click', () => { stopPaymentPoll(); document.getElementById('siteUpgradeDialog')?.close(); });
  document.getElementById('siteUpgradeDialog')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) { stopPaymentPoll(); event.currentTarget.close(); }
  });
  document.getElementById('revokeAllExtensionSessions')?.addEventListener('click', async () => { await api('/site/api/account/sessions/revoke-all', { method: 'POST', body: '{}' }); await refreshAccount(); });
  document.getElementById('changePasswordForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const out = document.getElementById('passwordNotice');
    setNotice(out, '正在更新密码…');
    try {
      await api('/site/api/account/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') }) });
      event.currentTarget.reset(); setNotice(out, '密码已更新，其他插件与网页登录已注销。', 'good'); await refreshAccount();
    } catch (error) { setNotice(out, error.message, 'error'); }
  });
  document.getElementById('deleteAccountForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const out = document.getElementById('deleteAccountNotice');
    const confirmText = String(form.get('confirmText') || '');
    if (confirmText !== 'DELETE') return setNotice(out, '请输入 DELETE 确认永久删除账户。', 'error');
    if (!window.confirm('永久删除 GPTWork 账户与关联数据？此操作不可撤销。')) return;
    try {
      await api('/site/api/account/delete', { method: 'POST', body: JSON.stringify({ currentPassword: form.get('currentPassword'), confirmText }) });
      location.href = '/data-deletion';
    } catch (error) { setNotice(out, error.message, 'error'); }
  });
}

async function redeemPendingShare() {
  const code = String(new URLSearchParams(location.search).get('invite') || '').trim().toUpperCase();
  if (!code || !state.account?.authenticated) return;
  try {
    const data = await api('/site/api/account/invite/redeem', { method: 'POST', body: JSON.stringify({ code }) });
    history.replaceState(null, '', location.pathname);
    setNotice(document.getElementById('rewardNotice'), data.alreadyRedeemed ? '该分享关系此前已经确认。' : '分享关系已确认。', 'good');
    await refreshAccount();
  } catch (error) {
    if (error.status !== 401) history.replaceState(null, '', location.pathname);
    setNotice(document.getElementById('rewardNotice'), `分享码处理失败：${error.message}`, 'error');
  }
}

async function refreshExpiredPromotion() {
  await loadUpgradeConfig();
  renderUpgradePlans();
}

async function boot() {
  setupMobileNavigation();
  installActions();
  await Promise.all([
    loadUpgradeConfig(),
    api('/site/api/website').then((data) => applyWebsiteChrome(data.config)).catch(() => {}),
  ]);
  const authenticated = await refreshAccount();
  if (authenticated) await redeemPendingShare();
  state.refreshTimer = setInterval(() => {
    if (!document.hidden && state.account?.authenticated) void refreshAccount();
  }, 10_000);
  state.promoTimer = setInterval(() => {
    let expired = false;
    document.querySelectorAll('[data-promo-countdown]').forEach((item) => {
      item.textContent = `限时优惠 · 恢复原价剩余时间 ${remainingText(item.dataset.promoCountdown)}`;
      if (Date.parse(item.dataset.promoCountdown || '') <= Date.now()) expired = true;
    });
    if (expired) void refreshExpiredPromotion();
  }, 1000);
}

window.addEventListener('pagehide', () => {
  stopPaymentPoll();
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  if (state.promoTimer) clearInterval(state.promoTimer);
}, { once: true });

void boot();
