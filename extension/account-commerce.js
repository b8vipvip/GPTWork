const state = { config: null, poll: null, countdown: null, observer: null };

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      if (!response?.ok) return reject(new Error(response?.error || '请求失败'));
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
function activePromo(plan) { return Boolean(plan?.promoActive && Date.parse(plan?.promoEndsAt || '') > Date.now()); }
function styles(node, values) { Object.assign(node.style, values); return node; }
function stopPoll() { if (state.poll) clearInterval(state.poll); state.poll = null; }
function closeModal() { stopPoll(); document.getElementById('gptworkExtPaymentOverlay')?.remove(); }

function openModal(result, method, plan) {
  closeModal();
  const order = result.order || result;
  const overlay = document.createElement('div'); overlay.id = 'gptworkExtPaymentOverlay';
  styles(overlay, { position: 'fixed', inset: '0', zIndex: '2147483000', background: 'rgba(15,23,42,.58)', display: 'grid', placeItems: 'center', padding: '18px' });
  const panel = document.createElement('section');
  styles(panel, { width: 'min(94vw,620px)', height: 'min(88vh,720px)', background: '#fff', borderRadius: '20px', overflow: 'hidden', boxShadow: '0 30px 80px rgba(15,23,42,.3)', display: 'grid', gridTemplateRows: 'auto auto 1fr auto' });
  const head = document.createElement('div'); styles(head, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 18px 10px' });
  const title = document.createElement('div');
  const strong = document.createElement('strong'); strong.textContent = `${paymentLabel(method.code)} · ${plan?.name || order.planSnapshot?.name || '会员开通'}`;
  const price = document.createElement('div'); price.textContent = order.paymentMethod === 'usdt' && order.payment?.amount ? `${order.payment.amount} USDT` : money(order.amountCents);
  styles(price, { color: '#dc2626', fontWeight: '900', fontSize: '22px', marginTop: '3px' }); title.append(strong, price);
  const close = document.createElement('button'); close.textContent = '×'; styles(close, { border: '0', background: 'transparent', fontSize: '28px' }); close.addEventListener('click', closeModal);
  head.append(title, close);
  const status = document.createElement('div'); status.id = 'gptworkExtPaymentStatus'; status.textContent = '请完成付款，支付结果会自动确认…';
  styles(status, { margin: '0 18px 10px', padding: '9px 11px', borderRadius: '10px', background: '#f0fdf4', color: '#166534', fontSize: '12px', fontWeight: '700' });
  const frameWrap = document.createElement('div'); styles(frameWrap, { minHeight: '0', background: '#f8fafc', borderTop: '1px solid #eef2f7', borderBottom: '1px solid #eef2f7' });
  const foot = document.createElement('div'); styles(foot, { padding: '10px 18px 14px', fontSize: '12px', color: '#64748b' });
  if (order.payUrl) {
    const iframe = document.createElement('iframe'); iframe.src = order.payUrl; iframe.title = '安全支付收银台'; iframe.setAttribute('allow', 'payment *');
    styles(iframe, { width: '100%', height: '100%', minHeight: '430px', border: '0', background: '#fff' }); frameWrap.append(iframe);
    const fallback = document.createElement('button'); fallback.textContent = '支付二维码未显示？在新窗口打开'; fallback.addEventListener('click', () => chrome.tabs.create({ url: order.payUrl })); foot.append(fallback);
  } else frameWrap.textContent = '当前支付方式没有可用支付页面。';
  panel.append(head, status, frameWrap, foot); overlay.append(panel); document.body.append(overlay);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeModal(); });
  const tick = async () => {
    try {
      const data = await sendMessage({ type: 'GPTLOCK_ACCOUNT_GET_ORDER', orderId: order.id });
      if (data.order?.status === 'paid') {
        stopPoll(); status.textContent = '支付成功，会员权益已自动开通。正在刷新…';
        setTimeout(async () => { closeModal(); await sendMessage({ type: 'GPTLOCK_ACCOUNT_REFRESH' }).catch(() => {}); location.reload(); }, 850);
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
    openModal(result, method, plan);
  } catch (error) {
    const message = document.getElementById('orderMessage'); if (message) { message.textContent = `开通失败：${error.message}`; message.className = 'message bad'; }
  } finally { button.disabled = false; button.textContent = old; }
}

function decorate() {
  if (!state.config) return;
  const cards = [...document.querySelectorAll('#plans .plan')];
  cards.forEach((card, index) => {
    const plan = state.config.plans?.[index]; if (!plan || card.dataset.commerceDecorated === plan.code) return;
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
    state.observer = new MutationObserver(decorate); state.observer.observe(document.getElementById('plans') || document.body, { childList: true, subtree: true });
    state.countdown = setInterval(() => document.querySelectorAll('[data-promo-countdown]').forEach((item) => {
      item.textContent = `限时优惠 · 恢复原价剩余时间 ${remainingText(item.dataset.promoCountdown)}`;
      if (Date.parse(item.dataset.promoCountdown || '') <= Date.now()) location.reload();
    }), 1000);
  } catch {}
}
window.addEventListener('pagehide', () => { stopPoll(); if (state.countdown) clearInterval(state.countdown); state.observer?.disconnect(); }, { once: true });
void boot();
