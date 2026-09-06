let cmsRichText = null;
const cmsRichTextPromise = import('/rich-text-style.js').catch(() => null);
const page = document.body.dataset.page || '';
const LEGACY_AUTO_RELEASE_BADGE = 'Windows / Linux · Chrome / Edge';

function text(value, fallback = '—') { return value === null || value === undefined || value === '' ? fallback : String(value); }
function dateText(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—';
}
function money(cents) { return `¥${(Number(cents || 0) / 100).toFixed(2)}`; }
function sizeText(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}
function safeHttps(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch { return ''; }
}
async function api(path, options = {}) {
  const init = { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } };
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || `请求失败 (${response.status})`), { status: response.status, code: data?.error?.code });
  return data;
}
function node(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (value !== undefined) el.textContent = value;
  return el;
}
function notice(el, message, tone = '') {
  if (!el) return;
  el.textContent = message;
  el.className = `notice${tone ? ` ${tone}` : ''}`;
}

function canonicalAssetForLegacy(name) {
  const value = String(name || '');
  if (value === 'GPTLockSetup-x64.exe') return 'GPTWorkSetup-x64.exe';
  if (value.startsWith('gptlock-extension-')) return value.replace('gptlock-extension-', 'gptwork-extension-');
  if (value.startsWith('gptlock-core-')) return value.replace('gptlock-core-', 'gptwork-core-');
  if (value.startsWith('gptlock_')) return value.replace('gptlock_', 'gptwork_');
  return '';
}

async function loadReleaseFeed() {
  const data = await api('/site/api/releases');
  const latest = data.releases?.[0];
  const badge = document.getElementById('latestBadge');
  if (badge && latest?.tag && badge.dataset.cmsOverride !== '1') badge.textContent = `${latest.tag} · Windows / Linux`;
  const feed = document.getElementById('releaseFeed');
  if (!feed) return;
  feed.replaceChildren();
  if (!data.releases?.length) {
    feed.append(node('div', 'loading', `当前服务端版本 ${text(data.currentVersion)}。暂时无法读取 GitHub 发布记录，请稍后刷新。`));
    return;
  }
  for (const release of data.releases) {
    const card = node('article', 'release-card');
    const top = node('div', 'release-top');
    const left = node('div');
    left.append(node('span', 'release-tag', release.tag || 'Release'));
    left.append(node('h2', '', release.name || release.tag));
    left.append(node('div', 'release-date', `发布于 ${dateText(release.publishedAt)}`));
    const releaseUrl = safeHttps(release.url);
    if (releaseUrl) {
      const source = node('a', 'btn btn-small btn-soft', 'GitHub 原始发布页');
      source.href = releaseUrl; source.target = '_blank'; source.rel = 'noopener noreferrer';
      top.append(left, source);
    } else top.append(left);
    card.append(top);
    if (release.notes) card.append(node('div', 'release-notes', release.notes));
    const assets = node('div', 'asset-row');
    const releaseAssets = release.assets || [];
    const releaseAssetNames = new Set(releaseAssets.map((asset) => String(asset?.name || '')));
    for (const asset of releaseAssets) {
      const canonical = canonicalAssetForLegacy(asset?.name);
      if (canonical && releaseAssetNames.has(canonical)) continue;
      const url = safeHttps(asset.url);
      if (!url) continue;
      const link = node('a', 'asset-link', `${asset.name}${asset.size ? ` · ${sizeText(asset.size)}` : ''}`);
      link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      assets.append(link);
    }
    if (assets.childElementCount) card.append(assets);
    feed.append(card);
  }
}

function listEmpty(container, message) { container.replaceChildren(node('div', 'loading', message)); }
function actionButton(label, onClick) {
  const button = node('button', 'btn btn-small btn-soft', label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

async function initAccount() {
  const loading = document.getElementById('accountLoading');
  const guest = document.getElementById('accountGuest');
  const dashboard = document.getElementById('accountDashboard');
  const loginCard = document.getElementById('loginCard');
  let config = { plans: [], paymentMethods: [] };
  const returnParams = new URLSearchParams(location.search);
  const zpayReturn = returnParams.get('zpay');
  const paypalReturn = returnParams.get('paypal');
  const alipayReturn = returnParams.get('alipay');
  try { config = await api('/site/api/account/config'); } catch {}
  try {
    const paymentConfig = await api('/site/api/payments');
    config.paymentMethods = paymentConfig.paymentMethods || config.paymentMethods || [];
  } catch {}

  async function refresh() {
    loading.classList.remove('hidden');
    try {
      const data = await api('/site/api/account/me');
      loading.classList.add('hidden'); guest.classList.add('hidden'); dashboard.classList.remove('hidden'); loginCard.classList.add('hidden');
      renderAccount(data, config, refresh);
      if (zpayReturn || paypalReturn || alipayReturn) {
        const box = document.getElementById('paymentBox');
        if (paypalReturn) notice(box, paypalReturn === 'success' ? 'PayPal 官方支付已完成，会员权益已刷新。' : paypalReturn === 'cancelled' ? 'PayPal 支付已取消。' : 'PayPal 支付未完成，请重新发起订单。', paypalReturn === 'success' ? 'good' : '');
        else if (alipayReturn) notice(box, '已从支付宝返回；系统将以支付宝官方异步通知验签结果为准，到账后自动刷新会员权益。');
        else notice(box, zpayReturn === 'success' ? 'ZPAY 已返回支付成功，会员权益已刷新。' : '已从 ZPAY 返回；如果刚完成付款，请稍候几秒等待异步回调并自动刷新。', zpayReturn === 'success' ? 'good' : '');
        history.replaceState(null, '', location.pathname);
      }
      return true;
    } catch (error) {
      loading.classList.add('hidden'); dashboard.classList.add('hidden'); guest.classList.remove('hidden'); loginCard.classList.remove('hidden');
      if (error.status !== 401) notice(document.getElementById('loginNotice'), error.message, 'error');
      return false;
    }
  }

  document.getElementById('siteLogin')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const out = document.getElementById('loginNotice');
    notice(out, '正在登录…');
    try {
      await api('/site/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
      notice(out, '登录成功', 'good');
      await refresh();
    } catch (error) { notice(out, error.message, 'error'); }
  });
  document.getElementById('siteLogout')?.addEventListener('click', async () => {
    await api('/site/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
    location.reload();
  });
  document.getElementById('changePasswordForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const out = document.getElementById('passwordNotice');
    notice(out, '正在更新密码…');
    try {
      await api('/site/api/account/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') }) });
      event.currentTarget.reset();
      notice(out, '密码已更新，其他插件与网页登录已注销。', 'good');
      await refresh();
    } catch (error) { notice(out, error.message, 'error'); }
  });
  document.getElementById('deleteAccountForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const out = document.getElementById('deleteAccountNotice');
    const confirmText = String(form.get('confirmText') || '');
    if (confirmText !== 'DELETE') return notice(out, '请输入 DELETE 确认永久删除账户。', 'error');
    if (!window.confirm('永久删除 GPTWork 账户与关联数据？此操作不可撤销。')) return;
    notice(out, '正在永久删除账户与关联数据…');
    try {
      await api('/site/api/account/delete', { method: 'POST', body: JSON.stringify({ currentPassword: form.get('currentPassword'), confirmText }) });
      event.currentTarget.reset();
      window.alert('GPTWork 账户与关联数据已删除。');
      location.href = '/data-deletion';
    } catch (error) { notice(out, error.message, 'error'); }
  });
  document.getElementById('revokeAllExtensionSessions')?.addEventListener('click', async () => {
    await api('/site/api/account/sessions/revoke-all', { method: 'POST', body: '{}' });
    await refresh();
  });
  await refresh();
  const accountPoll = setInterval(() => {
    if (!document.hidden && !dashboard.classList.contains('hidden')) void refresh();
  }, 10_000);
  window.addEventListener('pagehide', () => clearInterval(accountPoll), { once: true });
}

function paymentMethodLabel(method) {
  if (method.code === 'wechat') return method.provider === 'zpay' ? '微信支付（ZPAY）' : method.provider === 'wechat_official' ? '微信支付（官方 API）' : '微信支付';
  if (method.code === 'alipay') return method.provider === 'zpay' ? '支付宝（ZPAY）' : method.provider === 'alipay_official' ? '支付宝（官方 API）' : '支付宝';
  if (method.code === 'paypal') return 'PayPal（官方 API）';
  if (method.code === 'usdt') return 'USDT';
  return method.name || method.code;
}

function usdtMatchText(payment) {
  return ({
    awaiting: '等待检测到账',
    confirming: '已检测到付款，等待区块/OKX 最终确认',
    ambiguous: '检测到重复匹配，需要管理员核对',
    settled: 'OKX 已确认到账并自动开通',
    error: '自动核对异常，等待重试或管理员处理',
  })[payment?.matchStatus] || '';
}

function renderPaymentBox(result, method) {
  const box = document.getElementById('paymentBox');
  box.className = 'notice good payment-box';
  box.replaceChildren();
  box.append(node('strong', '', `订单 #${result.order.id} · ${paymentMethodLabel(method)}`));
  if (method.code === 'usdt') {
    const payment = result.order.payment || {};
    if (payment.amount) box.append(node('div', 'plan-price', `${payment.amount} USDT`));
    const parts = [];
    if (payment.network) parts.push(`网络：${payment.network}`);
    if (payment.address) parts.push(`地址：${payment.address}`);
    if (payment.memo) parts.push(`Memo/Tag：${payment.memo}`);
    if (parts.length) box.append(node('p', 'payment-crypto', parts.join('\n')));
  }
  if (result.instructions) box.append(node('p', '', result.instructions));
  const qr = safeHttps(method.qrUrl);
  if (qr) {
    const image = document.createElement('img');
    image.className = 'payment-qr';
    image.src = `${qr}${qr.includes('?') ? '&' : '?'}t=${Date.now()}`;
    image.alt = `${paymentMethodLabel(method)} 收款二维码`;
    box.append(image);
  }
  const pay = safeHttps(result.order.payUrl || method.payUrl);
  if (pay && pay !== qr) {
    const link = node('a', 'btn btn-small btn-soft', method.code === 'usdt' ? '打开欧易 / OKX 收款链接 →' : '打开支付页面 →');
    link.href = pay; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(link);
  }
  if (method.code === 'usdt') {
    box.append(node('small', '', method.autoConfirm
      ? '请严格按上方数量、网络与地址付款。服务端会通过 OKX 只读 API 核对金额、网络/地址和订单时间窗口；仅在 OKX 充值状态达到最终成功后自动开通会员。'
      : '当前尚未启用 OKX 自动到账核对；付款后需要管理员确认到账才能开通会员。'));
  } else if (method.provider === 'zpay') {
    box.append(node('small', '', '点击“打开支付页面”后将进入 ZPAY 收银台。只有服务端验证 ZPAY 回调签名、商户号、订单号、金额与支付渠道全部一致后，才会自动确认订单并开通会员。'));
  } else if (['wechat_official', 'alipay_official', 'paypal_official'].includes(method.provider)) {
    box.append(node('small', '', '该订单使用官方支付接口。服务端只在官方回调或服务器端 Capture 校验订单号、金额、币种与支付状态一致后自动开通会员。'));
  } else {
    box.append(node('small', '', '微信/支付宝静态收款码没有可信服务器回调：付款后订单保持待支付，由管理员核对实际到账并确认后开通会员。'));
  }
}

function renderAccount(data, config, refresh) {
  const account = data.account || {};
  const entitlement = account.entitlement || {};
  document.getElementById('accountEmail').textContent = text(account.user?.email);
  document.getElementById('entitlementSource').textContent = entitlement.source === 'membership' ? '会员' : entitlement.source === 'free' ? '免费权益' : '未激活';
  document.getElementById('entitlementExpiry').textContent = dateText(entitlement.expiresAt);
  document.getElementById('deviceUsage').textContent = `${Number(entitlement.usage?.devices || 0)} / ${Number(entitlement.limits?.devices || 0)}`;

  const deviceList = document.getElementById('deviceList'); deviceList.replaceChildren();
  for (const device of data.security?.devices || []) {
    const row = node('div', 'list-row');
    const main = node('div', 'list-main'); main.append(node('b', '', text(device.platform, '未知设备')), node('small', '', `最近活动 ${dateText(device.lastSeenAt)} · ${device.activeSessions} 个插件会话`));
    row.append(main, actionButton('释放设备', async () => { await api('/site/api/account/devices/release', { method: 'POST', body: JSON.stringify({ deviceRecordId: device.id }) }); await refresh(); }));
    deviceList.append(row);
  }
  if (!deviceList.childElementCount) listEmpty(deviceList, '暂无已绑定设备');

  const extensionList = document.getElementById('extensionSessionList'); extensionList.replaceChildren();
  for (const session of data.security?.sessions || []) {
    const row = node('div', 'list-row');
    const main = node('div', 'list-main'); main.append(node('b', '', `${text(session.platform, '未知平台')} · GPTWork ${text(session.extensionVersion, '未知版本')}`), node('small', '', `最近活动 ${dateText(session.lastSeenAt)}`));
    row.append(main, actionButton('注销', async () => { await api('/site/api/account/sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId: session.id }) }); await refresh(); }));
    extensionList.append(row);
  }
  if (!extensionList.childElementCount) listEmpty(extensionList, '当前没有活动的插件会话');

  const siteList = document.getElementById('siteSessionList'); siteList.replaceChildren();
  for (const session of data.security?.siteSessions || []) {
    const row = node('div', 'list-row');
    const main = node('div', 'list-main'); main.append(node('b', '', session.current ? '当前网页登录' : '网页登录'), node('small', '', `${text(session.ip, '未知 IP')} · ${dateText(session.lastSeenAt)} · ${text(session.userAgent, '')}`));
    row.append(main);
    if (!session.current) row.append(actionButton('注销', async () => { await api('/site/api/account/site-sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId: session.id }) }); await refresh(); }));
    siteList.append(row);
  }
  if (!siteList.childElementCount) listEmpty(siteList, '暂无网页登录');

  const planList = document.getElementById('planList'); planList.replaceChildren();
  const usdtMethod = (config.paymentMethods || []).find((item) => item.code === 'usdt');
  for (const plan of config.plans || []) {
    const card = node('div', 'plan');
    card.append(node('strong', '', plan.name), node('div', 'plan-price', money(plan.priceCents)), node('small', '', `${plan.durationDays} 天 · 最多 ${plan.limits?.devices || 1} 台设备`));
    const usdtPrice = usdtMethod?.planPrices?.[plan.code] || '';
    if (usdtPrice) card.append(node('small', '', `USDT：${usdtPrice} USDT`));
    if (config.paymentMethods?.length) {
      const select = document.createElement('select');
      select.className = 'payment-method-select';
      select.setAttribute('aria-label', '选择支付方式');
      for (const method of config.paymentMethods) {
        const option = document.createElement('option');
        option.value = method.code;
        const price = method.code === 'usdt' ? method.planPrices?.[plan.code] : '';
        option.textContent = method.code === 'usdt' && price ? `USDT · ${price} USDT` : paymentMethodLabel(method);
        if (method.code === 'usdt' && !price) { option.disabled = true; option.textContent = 'USDT · 该套餐未配置价格'; }
        select.append(option);
      }
      card.append(select, actionButton('创建购买订单', async () => {
        const method = config.paymentMethods.find((item) => item.code === select.value) || config.paymentMethods[0];
        try {
          const result = await api('/site/api/account/orders', { method: 'POST', body: JSON.stringify({ planCode: plan.code, paymentMethod: method.code }) });
          renderPaymentBox(result, method);
          await refresh();
        } catch (error) {
          const box = document.getElementById('paymentBox'); notice(box, error.message, 'error');
        }
      }));
    }
    planList.append(card);
  }
  if (!planList.childElementCount) listEmpty(planList, '当前没有可购买的会员方案');

  const orderList = document.getElementById('orderList'); orderList.replaceChildren();
  for (const order of data.orders || []) {
    const row = node('div', 'list-row');
    const main = node('div', 'list-main');
    const amountText = order.paymentMethod === 'usdt' && order.payment?.amount ? `${order.payment.amount} USDT` : money(order.amountCents);
    const detail = [text(order.status), dateText(order.createdAt)];
    const matchText = usdtMatchText(order.payment);
    if (matchText) detail.push(matchText);
    if (order.payment?.txId) detail.push(`TxID ${order.payment.txId}`);
    main.append(node('b', '', `#${order.id} · ${text(order.planSnapshot?.name, order.planCode)} · ${amountText}`), node('small', '', detail.join(' · ')));
    row.append(main);
    const pay = safeHttps(order.payUrl);
    if (order.status === 'pending' && pay) { const link = node('a', 'btn btn-small btn-soft', order.paymentMethod === 'usdt' ? '继续 USDT 支付' : '继续支付'); link.href = pay; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
    orderList.append(row);
  }
  if (!orderList.childElementCount) listEmpty(orderList, '暂无订单');
}

function cmsText(target, value, style = {}) {
  if (!target || value === undefined || value === null) return;
  target.textContent = String(value);
  if (String(value).includes('\n')) target.style.whiteSpace = 'pre-line';
  cmsRichText?.applyTextStyle(target, style);
}
function cmsNode(tag, className, value, style = {}) { const el = node(tag, className, value); cmsRichText?.applyTextStyle(el, style); return el; }
function cmsLink(target, label, href, style = {}) {
  if (!target) return;
  cmsText(target, label || '', style);
  if (href) target.href = href;
  target.hidden = !label;
}
function pathMatches(href) {
  try {
    const url = new URL(href, location.origin);
    const current = location.pathname.replace(/\/$/, '') || '/';
    const target = url.pathname.replace(/\/$/, '') || '/';
    return current === target;
  } catch { return false; }
}
function decorateLink(link, item) {
  link.href = item.href || '/';
  if (/^https:\/\//.test(link.href) && !link.href.startsWith(location.origin)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  if (pathMatches(item.href)) link.setAttribute('aria-current', 'page');
}
function setupMobileNavigation(nav) {
  if (!nav || nav.dataset.mobileReady === '1') return;
  const shell = nav.closest('.nav'); if (!shell) return;
  nav.dataset.mobileReady = '1'; nav.id ||= 'siteNavigation';
  const toggle = node('button', 'nav-toggle', '菜单');
  toggle.type = 'button'; toggle.setAttribute('aria-controls', nav.id); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-label', '打开网站导航');
  const close = () => { nav.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-label', '打开网站导航'); };
  toggle.addEventListener('click', () => {
    const open = !nav.classList.contains('is-open'); nav.classList.toggle('is-open', open); toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', open ? '关闭网站导航' : '打开网站导航');
  });
  nav.addEventListener('click', (event) => { if (event.target.closest('a')) close(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  shell.insertBefore(toggle, nav);
}
function applyGlobalWebsiteConfig(config) {
  const site = config.site || {};
  const brand = document.querySelector('.site-header .brand > span:last-child'); if (brand && site.brandName) cmsText(brand, site.brandName, site.styles?.brandName);
  const footer = document.querySelector('.site-footer .footer-row > span'); if (footer && site.footerText) cmsText(footer, site.footerText, site.styles?.footerText);
  const items = Array.isArray(config.navigation) ? [...config.navigation].filter((item) => item.enabled).sort((a, b) => Number(a.order) - Number(b.order)) : [];
  const nav = document.querySelector('.site-header .nav-links');
  if (nav && Array.isArray(config.navigation)) {
    nav.replaceChildren();
    for (const item of items) {
      const link = cmsNode('a', item.account ? 'nav-account' : '', item.label || '链接', item.styles?.label); decorateLink(link, item); nav.append(link);
    }
    setupMobileNavigation(nav);
  }
  const footerLinks = document.querySelector('.site-footer .footer-links');
  if (footerLinks && Array.isArray(config.navigation)) {
    const legal = [{ label: '隐私', href: '/privacy' }, { label: '条款', href: '/terms' }, { label: '数据删除', href: '/data-deletion' }];
    const merged = []; const seen = new Set();
    for (const item of [...items, ...legal]) {
      const key = String(item.href || '/'); if (seen.has(key)) continue; seen.add(key); merged.push(item);
    }
    footerLinks.replaceChildren();
    for (const item of merged) { const link = cmsNode('a', '', item.label || '链接', item.styles?.label); decorateLink(link, item); footerLinks.append(link); }
  }
  if (page === 'home') {
    if (site.title) document.title = site.title;
    const meta = document.querySelector('meta[name="description"]'); if (meta && site.description) meta.content = site.description;
  }
}
function homeSections() {
  const sections = [...document.querySelectorAll('main > section')].filter((section) => !section.dataset.cmsCustom);
  const ids = ['hero', 'features', 'workflow', 'callout'];
  const map = new Map();
  ids.forEach((id, index) => { if (sections[index]) { sections[index].dataset.cmsModule = id; map.set(id, sections[index]); } });
  return map;
}
function applyHero(section, module) {
  const badge = section.querySelector('#latestBadge'); const customBadge = String(module.badge || '').trim();
  if (badge) {
    delete badge.dataset.cmsOverride;
    if (customBadge && customBadge !== LEGACY_AUTO_RELEASE_BADGE) { cmsText(badge, customBadge, module.styles?.badge); badge.dataset.cmsOverride = '1'; }
    else cmsRichText?.applyTextStyle(badge, module.styles?.badge);
  }
  cmsText(section.querySelector('h1'), module.title, module.styles?.title); cmsText(section.querySelector('.hero-copy'), module.body, module.styles?.body);
  const actions = section.querySelectorAll('.hero-actions a'); cmsLink(actions[0], module.primaryLabel, module.primaryHref, module.styles?.primaryLabel); cmsLink(actions[1], module.secondaryLabel, module.secondaryHref, module.styles?.secondaryLabel); cmsLink(actions[2], module.tertiaryLabel, module.tertiaryHref, module.styles?.tertiaryLabel);
  cmsText(section.querySelector('.status-pill'), module.statusLabel, module.styles?.statusLabel);
  const labels = section.querySelectorAll('.lock-label'); const values = section.querySelectorAll('.lock-value');
  const labelValues = [module.modeLabel, module.stateLabel, module.modelLabel, module.reasoningLabel, module.protectionLabel];
  const labelStyles = [module.styles?.modeLabel, module.styles?.stateLabel, module.styles?.modelLabel, module.styles?.reasoningLabel, module.styles?.protectionLabel];
  const stateValues = [module.modeValue, module.stateValue, module.modelValue, module.reasoningValue, module.protectionValue];
  const stateStyles = [module.styles?.modeValue, module.styles?.stateValue, module.styles?.modelValue, module.styles?.reasoningValue, module.styles?.protectionValue];
  labels.forEach((item, index) => cmsText(item, labelValues[index], labelStyles[index])); values.forEach((item, index) => cmsText(item, stateValues[index], stateStyles[index]));
  cmsText(section.querySelector('.hero-card.note'), module.noteText, module.styles?.noteText);
  const signal = section.querySelector('.hero-card.signal'); if (signal) { cmsText(signal.querySelector('b'), module.signalTitle, module.styles?.signalTitle); cmsText(signal.querySelector('small'), module.signalText, module.styles?.signalText); }
}
function applyFeatures(section, module) {
  cmsText(section.querySelector('.section-head h2'), module.title, module.styles?.title); cmsText(section.querySelector('.section-head p'), module.lead, module.styles?.lead);
  const grid = section.querySelector('.grid-3'); if (!grid) return; grid.replaceChildren();
  (module.items || []).forEach((item, index) => { const card = node('article', 'feature-card'); card.append(node('div', 'feature-icon', String(index + 1).padStart(2, '0')), cmsNode('h3', '', item.title || '', item.styles?.title), cmsNode('p', '', item.body || '', item.styles?.body)); grid.append(card); });
}
function workflowNode(item, index) {
  const accents = ['acid', '', 'sky', 'coral', '', 'acid', 'sky', 'coral'];
  const mapNode = node('div', `map-node${accents[index] ? ` ${accents[index]}` : ''}`); mapNode.append(cmsNode('b', '', item.title || '', item.styles?.title), cmsNode('span', '', item.body || '', item.styles?.body)); return mapNode;
}
function applyWorkflow(section, module) {
  cmsText(section.querySelector('.section-head h2'), module.title, module.styles?.title); cmsText(section.querySelector('.section-head p'), module.lead, module.styles?.lead);
  const columns = section.querySelectorAll('.map-col'); const items = (module.items || []).slice(0, 8);
  if (columns.length >= 2) {
    const split = Math.ceil(items.length / 2); columns[0].replaceChildren(...items.slice(0, split).map((item, index) => workflowNode(item, index))); columns[1].replaceChildren(...items.slice(split).map((item, index) => workflowNode(item, split + index)));
  }
  const actions = section.querySelectorAll('.hero-actions a'); cmsLink(actions[0], module.primaryLabel, module.primaryHref, module.styles?.primaryLabel); cmsLink(actions[1], module.secondaryLabel, module.secondaryHref, module.styles?.secondaryLabel);
}
function applyCallout(section, module) { cmsText(section.querySelector('h2'), module.title, module.styles?.title); cmsText(section.querySelector('p'), module.body, module.styles?.body); cmsLink(section.querySelector('a.btn'), module.buttonLabel, module.buttonHref, module.styles?.buttonLabel); }
function createCustomModule(module) {
  const section = node('section', 'section'); section.dataset.cmsCustom = module.id; section.dataset.cmsModule = module.id;
  const shell = node('div', 'shell'); const head = node('div', 'section-head'); const left = node('div'); const title = cmsNode('h2', '', module.title || '', module.styles?.title); const body = cmsNode('p', '', module.body || '', module.styles?.body); title.style.whiteSpace = 'pre-line'; body.style.whiteSpace = 'pre-line'; left.append(title, body); head.append(left); shell.append(head);
  if (module.buttonLabel) { const actions = node('div', 'hero-actions'); const link = cmsNode('a', 'btn btn-primary', module.buttonLabel, module.styles?.buttonLabel); link.href = module.buttonHref || '/'; actions.append(link); shell.append(actions); }
  section.append(shell); return section;
}
function applyHomeModules(config) {
  const main = document.querySelector('main'); if (!main) return;
  document.querySelectorAll('[data-cms-custom]').forEach((item) => item.remove());
  const defaults = homeSections();
  const modules = [...(config.homeModules || [])].sort((a, b) => Number(a.order) - Number(b.order));
  for (const module of modules) {
    let section = defaults.get(module.id);
    if (!section && module.type === 'custom') section = createCustomModule(module);
    if (!section) continue;
    section.hidden = !module.enabled;
    if (module.type === 'hero') applyHero(section, module);
    else if (module.type === 'features') applyFeatures(section, module);
    else if (module.type === 'workflow') applyWorkflow(section, module);
    else if (module.type === 'callout') applyCallout(section, module);
    main.append(section);
  }
}
async function loadWebsiteConfig() {
  cmsRichText = await cmsRichTextPromise;
  const data = await api('/site/api/website');
  const config = data.config || {};
  applyGlobalWebsiteConfig(config);
  if (page === 'home') applyHomeModules(config);
}

setupMobileNavigation(document.querySelector('.site-header .nav-links'));
void loadWebsiteConfig().catch(() => {});
if (page === 'home') void loadReleaseFeed().catch(() => {});
if (page === 'releases') void loadReleaseFeed().catch((error) => {
  const feed = document.getElementById('releaseFeed');
  if (feed) feed.replaceChildren(node('div', 'loading', `版本信息读取失败：${error.message}`));
});
if (page === 'account') void initAccount();