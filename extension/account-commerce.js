const API_BASE = 'https://gptlock.mv3.cn';
const SESSION_KEY = 'gptlockAccountSessionToken';
const state = { config: null, poll: null, countdown: null, orderRefresh: null, observer: null, orders: [] };

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      if (!response?.ok) return reject(Object.assign(new Error(response?.error || '请求失败'), { status: response?.status, code: response?.code }));
      resolve(response.data);
    });
  });
}
function money(cents) { return `¥${(Number(cents || 0) / 100).toFixed(2)}`; }
function paymentLabel(code) {
  if (code === 'wechat') return '微信支付';
  if (code === 'alipay') return '支付宝';
  if (code === 'paypal') return 'PayPal';
  if (code === 'usdt') return 'USDT';
  return String(code || '支付');
}
function orderStatusLabel(status) {
  return ({ pending: '待支付', paid: '支付成功 · 已升级', expired: '已失效', cancelled: '已取消' })[status] || String(status || '未知');
}
function localDate(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—';
}
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
function orderRemainingText(endValue) {
  const ms = Date.parse(endValue || '') - Date.now();
  if (!(ms > 0)) return '已失效';
  const seconds = Math.ceil(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return hours > 0
    ? `剩余 ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `剩余 ${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
function activePromo(plan) { return Boolean(plan?.promoActive && Date.parse(plan?.promoEndsAt || '') > Date.now()); }
function styles(node, values) { Object.assign(node.style, values); return node; }
function stopPoll() { if (state.poll) clearInterval(state.poll); state.poll = null; }
function closeModal() { stopPoll(); document.getElementById('gptworkExtPaymentOverlay')?.remove(); }

function rememberOrder(order) {
  const id = Number(order?.id);
  if (!Number.isInteger(id) || id <= 0) return;
  const index = state.orders.findIndex((item) => Number(item.id) === id);
  if (index >= 0) state.orders.splice(index, 1);
  state.orders.unshift(order);
  state.orders = state.orders.slice(0, 20);
  renderOrders();
}

async function fetchAccountOrders(limit = 20) {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const token = typeof stored[SESSION_KEY] === 'string' ? stored[SESSION_KEY] : '';
  if (!token) return { orders: [] };
  const response = await fetch(`${API_BASE}/api/v1/account/orders?limit=${Math.max(1, Math.min(50, Number(limit) || 20))}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
    credentials: 'omit',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.error?.code || `HTTP_${response.status}`;
    throw error;
  }
  return data;
}

async function refreshOrders() {
  try {
    const data = await fetchAccountOrders(20);
    state.orders = Array.isArray(data.orders) ? data.orders : [];
    renderOrders();
  } catch (error) {
    if (Number(error?.status) === 401) {
      state.orders = [];
      renderOrders();
    }
  }
}

function openModal(result, method, plan) {
  closeModal();
  const order = result.order || result;
  rememberOrder(order);
  const overlay = document.createElement('div'); overlay.id = 'gptworkExtPaymentOverlay';
  styles(overlay, { position: 'fixed', inset: '0', zIndex: '2147483000', background: 'rgba(15,23,42,.58)', display: 'grid', placeItems: 'center', padding: '18px' });
  const panel = document.createElement('section');
  styles(panel, { width: 'min(94vw,620px)', height: 'min(88vh,720px)', background: '#fff', borderRadius: '20px', overflow: 'hidden', boxShadow: '0 30px 80px rgba(15,23,42,.3)', display: 'grid', gridTemplateRows: 'auto auto 1fr auto' });
  const head = document.createElement('div'); styles(head, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 18px 10px' });
  const title = document.createElement('div');
  const strong = document.createElement('strong'); strong.textContent = `${paymentLabel(method.code)} · ${plan?.name || order.planSnapshot?.name || '等级升级'}`;
  const price = document.createElement('div'); price.textContent = order.paymentMethod === 'usdt' && order.payment?.amount ? `${order.payment.amount} USDT` : money(order.amountCents);
  styles(price, { color: '#dc2626', fontWeight: '900', fontSize: '22px', marginTop: '3px' }); title.append(strong, price);
  const close = document.createElement('button'); close.textContent = '×'; styles(close, { border: '0', background: 'transparent', fontSize: '28px' }); close.addEventListener('click', closeModal);
  head.append(title, close);
  const status = document.createElement('div'); status.id = 'gptworkExtPaymentStatus'; status.textContent = '请完成付款，支付结果会自动确认…';
  styles(status, { margin: '0 18px 10px', padding: '9px 11px', borderRadius: '10px', background: '#f0fdf4', color: '#166534', fontSize: '12px', fontWeight: '700' });
  const frameWrap = document.createElement('div'); styles(frameWrap, { minHeight: '0', background: '#f8fafc', borderTop: '1px solid #eef2f7', borderBottom: '1px solid #eef2f7' });
  const foot = document.createElement('div'); styles(foot, { padding: '10px 18px 14px', fontSize: '12px', color: '#64748b' });
  const qrUrl = String(order.payment?.qrImageUrl || '');
  if (qrUrl.startsWith('https://')) {
    const img = document.createElement('img'); img.src = qrUrl; img.alt = `${paymentLabel(method.code)}支付二维码`;
    styles(img, { display: 'block', width: '280px', maxWidth: '80%', margin: '28px auto 14px', borderRadius: '14px' }); frameWrap.append(img);
    const hint = document.createElement('div'); hint.textContent = `请使用${paymentLabel(method.code)}扫码完成支付`; styles(hint, { textAlign: 'center', color: '#475569', fontSize: '13px', fontWeight: '700', paddingBottom: '20px' }); frameWrap.append(hint);
  } else if (order.payUrl) {
    const iframe = document.createElement('iframe'); iframe.src = order.payUrl; iframe.title = '安全支付收银台'; iframe.setAttribute('allow', 'payment *');
    styles(iframe, { width: '100%', height: '100%', minHeight: '430px', border: '0', background: '#fff' }); frameWrap.append(iframe);
    const fallback = document.createElement('button'); fallback.textContent = '支付二维码未显示？在新窗口打开'; fallback.addEventListener('click', () => chrome.tabs.create({ url: order.payUrl })); foot.append(fallback);
  } else frameWrap.textContent = '当前支付方式没有可用支付页面。';
  panel.append(head, status, frameWrap, foot); overlay.append(panel); document.body.append(overlay);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeModal(); });
  const tick = async () => {
    try {
      const data = await sendMessage({ type: 'GPTLOCK_ACCOUNT_GET_ORDER', orderId: order.id });
      if (data.order) rememberOrder(data.order);
      if (data.order?.status === 'paid') {
        stopPoll(); status.textContent = '支付成功，用户等级权益已自动升级。正在刷新…';
        setTimeout(async () => { closeModal(); await sendMessage({ type: 'GPTLOCK_ACCOUNT_REFRESH' }).catch(() => {}); await refreshOrders(); location.reload(); }, 850);
      } else if (['cancelled', 'expired'].includes(data.order?.status)) {
        stopPoll(); status.textContent = data.order.status === 'expired' ? '订单已过期，请重新开通。' : '订单已取消。';
        styles(status, { background: '#fef2f2', color: '#991b1b' });
      }
    } catch {}
  };
  void tick(); state.poll = setInterval(tick, 2000);
}

async function createOrder(plan, method, button) {
  const old = button.textContent; button.disabled = true; button.textContent = '正在打开…';
  try {
    const result = await sendMessage({ type: 'GPTLOCK_ACCOUNT_CREATE_ORDER', planCode: plan.code, paymentMethod: method.code });
    rememberOrder(result.order);
    openModal(result, method, plan);
  } catch (error) {
    const message = document.getElementById('orderMessage'); if (message) { message.textContent = `开通失败：${error.message}`; message.className = 'message bad'; }
  } finally { button.disabled = false; button.textContent = old; }
}

function renderOrders() {
  const list = document.getElementById('recentOrders');
  if (!list) return;
  list.replaceChildren();
  if (!state.orders.length) {
    const empty = document.createElement('div'); empty.textContent = '暂无最近订单'; styles(empty, { color: '#64748b', padding: '8px 0' }); list.append(empty); return;
  }
  for (const order of state.orders) {
    const row = document.createElement('article');
    styles(row, { display: 'flex', gap: '14px', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderTop: '1px solid #eef2f7' });
    row.dataset.orderId = String(order.id);
    row.dataset.orderExpiresAt = String(order.expiresAt || '');
    const copy = document.createElement('div'); styles(copy, { minWidth: '0' });
    const title = document.createElement('strong');
    const amount = order.paymentMethod === 'usdt' && order.payment?.amount ? `${order.payment.amount} USDT` : money(order.amountCents);
    title.textContent = `#${order.id} · ${order.planSnapshot?.name || order.planCode || '用户等级'} · ${amount}`;
    const meta = document.createElement('p'); styles(meta, { margin: '5px 0 0', color: '#64748b', fontSize: '12px' });
    meta.textContent = `${orderStatusLabel(order.status)} · ${localDate(order.createdAt)}`;
    if (order.status === 'pending') {
      const countdown = document.createElement('span'); countdown.dataset.orderCountdown = '1'; countdown.textContent = ` · ${orderRemainingText(order.expiresAt)}`;
      styles(countdown, { color: '#b45309', fontWeight: '800' }); meta.append(countdown);
    }
    copy.append(title, meta); row.append(copy);
    if (order.status === 'pending' && Date.parse(order.expiresAt || '') > Date.now()) {
      const button = document.createElement('button'); button.className = 'primary'; button.textContent = '继续支付'; styles(button, { flex: '0 0 auto' });
      button.addEventListener('click', () => {
        const method = state.config?.paymentMethods?.find((item) => item.code === order.paymentMethod) || { code: order.paymentMethod };
        const plan = state.config?.plans?.find((item) => item.code === order.planCode) || order.planSnapshot || null;
        openModal({ order }, method, plan);
      });
      row.append(button);
    }
    list.append(row);
  }
}

function tickOrderCountdowns() {
  let needsRefresh = false;
  document.querySelectorAll('#recentOrders [data-order-expires-at]').forEach((row) => {
    const order = state.orders.find((item) => String(item.id) === row.dataset.orderId);
    if (!order || order.status !== 'pending') return;
    const countdown = row.querySelector('[data-order-countdown]');
    const value = orderRemainingText(order.expiresAt);
    if (countdown) countdown.textContent = ` · ${value}`;
    if (value === '已失效' && row.querySelector('button')) needsRefresh = true;
  });
  if (needsRefresh) void refreshOrders();
}

function decorate() {
  if (!state.config) return;
  const cards = [...document.querySelectorAll('#plans .plan')];
  cards.forEach((card, index) => {
    const plan = state.config.plans?.find((item) => item.code === card.dataset.planCode) || state.config.plans?.[index]; if (!plan || card.dataset.commerceDecorated === plan.code) return;
    card.dataset.commerceDecorated = plan.code;
    styles(card, { position: 'relative', borderColor: activePromo(plan) ? '#fecaca' : '#dbe3ef', boxShadow: activePromo(plan) ? '0 15px 34px rgba(239,68,68,.10)' : '' });
    const price = card.querySelector('.price');
    if (price) {
      price.replaceChildren();
      const current = document.createElement('span'); current.textContent = money(plan.priceCents); styles(current, { color: '#dc2626', fontWeight: '900', fontSize: '28px' }); price.append(current);
      if (activePromo(plan)) {
        const original = document.createElement('span'); original.textContent = `原价 ${money(plan.originalPriceCents)}`; styles(original, { marginLeft: '8px', color: '#94a3b8', fontSize: '12px', textDecoration: 'line-through' });
        const save = document.createElement('span'); save.textContent = `立省 ${money(plan.savingsCents)}`; styles(save, { marginLeft: '7px', color: '#991b1b', fontSize: '11px', background: '#fee2e2', borderRadius: '999px', padding: '3px 7px' });
        price.append(original, save);
        const countdown = document.createElement('div'); countdown.dataset.promoCountdown = plan.promoEndsAt; countdown.textContent = `限时优惠 · 恢复原价剩余时间 ${remainingText(plan.promoEndsAt)}`;
        styles(countdown, { color: '#991b1b', fontSize: '11px', fontWeight: '750', marginTop: '6px' }); price.after(countdown);
      }
    }
    const row = card.querySelector('.pay-row'); if (!row) return;
    row.replaceChildren();
    if (!(state.config.paymentMethods || []).length) {
      const disabled = document.createElement('button'); disabled.disabled = true; disabled.textContent = '支付方式暂未配置'; row.append(disabled); return;
    }
    const select = document.createElement('select');
    styles(select, { flex: '1 1 150px', minWidth: '0', border: '1px solid #cbd5e1', borderRadius: '10px', padding: '8px 10px', background: '#fff' });
    for (const method of state.config.paymentMethods) {
      const option = document.createElement('option'); option.value = method.code; option.textContent = paymentLabel(method.code); select.append(option);
    }
    const button = document.createElement('button'); button.className = 'primary'; button.textContent = '开通';
    styles(button, { flex: '0 0 112px', background: '#16a34a', borderColor: '#16a34a', fontWeight: '850' });
    button.addEventListener('click', () => {
      const method = state.config.paymentMethods.find((item) => item.code === select.value) || state.config.paymentMethods[0];
      void createOrder(plan, method, button);
    });
    row.append(select, button);
  });
}
async function boot() {
  try {
    state.config = await sendMessage({ type: 'GPTLOCK_ACCOUNT_CONFIG' });
    decorate();
    renderOrders();
    void refreshOrders();
    state.observer = new MutationObserver(decorate); state.observer.observe(document.getElementById('plans') || document.body, { childList: true, subtree: true });
    state.countdown = setInterval(() => {
      document.querySelectorAll('[data-promo-countdown]').forEach((item) => {
        item.textContent = `限时优惠 · 恢复原价剩余时间 ${remainingText(item.dataset.promoCountdown)}`;
        if (Date.parse(item.dataset.promoCountdown || '') <= Date.now()) location.reload();
      });
      tickOrderCountdowns();
    }, 1000);
    state.orderRefresh = setInterval(() => { if (!document.hidden) void refreshOrders(); }, 10_000);
  } catch {}
}
window.addEventListener('pagehide', () => {
  stopPoll();
  if (state.countdown) clearInterval(state.countdown);
  if (state.orderRefresh) clearInterval(state.orderRefresh);
  state.observer?.disconnect();
}, { once: true });
void boot();