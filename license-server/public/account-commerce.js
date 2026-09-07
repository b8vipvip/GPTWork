const state = { config: null, countdown: null, poll: null, observer: null };

function money(cents) { return `¥${(Number(cents || 0) / 100).toFixed(2)}`; }
function paymentLabel(code) {
  if (code === 'wechat') return '微信支付';
  if (code === 'alipay') return '支付宝';
  if (code === 'paypal') return 'PayPal';
  if (code === 'usdt') return 'USDT';
  return String(code || '支付');
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store',
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error?.message || `请求失败 (${response.status})`);
  return body;
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
function activePromo(plan) {
  return Boolean(plan?.promoActive && Number(plan?.promoPriceCents) < Number(plan?.originalPriceCents) && Date.parse(plan?.promoEndsAt || '') > Date.now());
}
function setStyles(node, styles) { Object.assign(node.style, styles); return node; }

function decoratePlans() {
  const root = document.getElementById('planList');
  if (!root || !state.config) return;
  const cards = [...root.querySelectorAll('.plan')];
  const plans = state.config.plans || [];
  cards.forEach((card, index) => {
    const plan = plans[index];
    if (!plan || card.dataset.commerceDecorated === plan.code) return;
    card.dataset.commerceDecorated = plan.code;
    setStyles(card, {
      position: 'relative', overflow: 'hidden',
      borderColor: activePromo(plan) ? '#fecaca' : '#e5e7eb',
      boxShadow: activePromo(plan) ? '0 16px 36px rgba(239,68,68,.10)' : '0 10px 28px rgba(15,23,42,.05)',
    });
    const price = card.querySelector('.plan-price');
    if (price) {
      price.replaceChildren();
      const current = document.createElement('span'); current.textContent = money(plan.priceCents);
      setStyles(current, { color: '#dc2626', fontSize: '30px', fontWeight: '900', letterSpacing: '-.02em' });
      price.append(current);
      if (activePromo(plan)) {
        const original = document.createElement('span'); original.textContent = `原价 ${money(plan.originalPriceCents)}`;
        setStyles(original, { color: '#94a3b8', fontSize: '13px', fontWeight: '600', textDecoration: 'line-through', marginLeft: '10px' });
        const save = document.createElement('span'); save.textContent = `立省 ${money(plan.savingsCents)}`;
        setStyles(save, { color: '#b91c1c', fontSize: '12px', fontWeight: '800', background: '#fee2e2', borderRadius: '999px', padding: '4px 8px', marginLeft: '8px' });
        price.append(original, save);
        const countdown = document.createElement('div'); countdown.dataset.promoCountdown = plan.promoEndsAt;
        countdown.textContent = `限时优惠 · 恢复原价剩余时间 ${remainingText(plan.promoEndsAt)}`;
        setStyles(countdown, { marginTop: '9px', color: '#991b1b', fontSize: '12px', fontWeight: '750' });
        price.after(countdown);
      }
    }
    const select = card.querySelector('.payment-method-select');
    if (select) {
      for (const option of select.options) {
        const method = (state.config.paymentMethods || []).find((item) => item.code === option.value);
        if (!method) continue;
        option.textContent = method.code === 'usdt' && method.planPrices?.[plan.code]
          ? `USDT · ${method.planPrices[plan.code]} USDT`
          : paymentLabel(method.code);
      }
    }
    const button = [...card.querySelectorAll('button')].find((item) => /创建购买订单|开通/.test(item.textContent || ''));
    if (button) {
      button.textContent = '开通'; button.dataset.commerceOpen = plan.code; button.classList.remove('btn-soft');
      setStyles(button, {
        display: 'block', width: '156px', maxWidth: '100%', margin: '12px auto 0',
        background: '#16a34a', borderColor: '#16a34a', color: '#fff', fontWeight: '850', borderRadius: '10px',
        boxShadow: '0 8px 18px rgba(22,163,74,.20)',
      });
    }
  });
}

function stopPoll() { if (state.poll) clearInterval(state.poll); state.poll = null; }
function closeModal() { stopPoll(); document.getElementById('gptworkPaymentOverlay')?.remove(); }
function modalShell(title, amount) {
  closeModal();
  const overlay = document.createElement('div'); overlay.id = 'gptworkPaymentOverlay';
  setStyles(overlay, { position: 'fixed', inset: '0', background: 'rgba(15,23,42,.58)', zIndex: '2147483000', display: 'grid', placeItems: 'center', padding: '20px' });
  const panel = document.createElement('section');
  setStyles(panel, { width: 'min(94vw,620px)', height: 'min(86vh,720px)', background: '#fff', borderRadius: '20px', boxShadow: '0 30px 80px rgba(15,23,42,.28)', overflow: 'hidden', display: 'grid', gridTemplateRows: 'auto auto 1fr auto' });
  const head = document.createElement('div'); setStyles(head, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px 10px' });
  const copy = document.createElement('div');
  const heading = document.createElement('strong'); heading.textContent = title; setStyles(heading, { fontSize: '18px' });
  const price = document.createElement('div'); price.textContent = amount; setStyles(price, { color: '#dc2626', fontSize: '22px', fontWeight: '900', marginTop: '3px' });
  copy.append(heading, price);
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭支付窗口');
  setStyles(close, { border: '0', background: 'transparent', fontSize: '28px', cursor: 'pointer', padding: '4px 8px', color: '#64748b' }); close.addEventListener('click', closeModal);
  head.append(copy, close);
  const status = document.createElement('div'); status.id = 'gptworkPaymentStatus'; status.textContent = '请完成付款，支付结果会自动确认…';
  setStyles(status, { margin: '0 18px 10px', padding: '9px 11px', borderRadius: '10px', background: '#f0fdf4', color: '#166534', fontSize: '12px', fontWeight: '700' });
  const frameWrap = document.createElement('div'); setStyles(frameWrap, { minHeight: '0', borderTop: '1px solid #eef2f7', borderBottom: '1px solid #eef2f7', background: '#f8fafc' });
  const foot = document.createElement('div'); setStyles(foot, { padding: '10px 18px 14px', fontSize: '12px', color: '#64748b' });
  panel.append(head, status, frameWrap, foot); overlay.append(panel); document.body.append(overlay);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeModal(); });
  return { status, frameWrap, foot };
}
async function pollOrder(orderId) {
  stopPoll();
  const tick = async () => {
    try {
      const data = await api(`/site/api/account/orders/${encodeURIComponent(orderId)}`); const order = data.order || {};
      const status = document.getElementById('gptworkPaymentStatus');
      if (order.status === 'paid') {
        stopPoll();
        if (status) { status.textContent = '支付成功，会员权益已自动开通。正在刷新…'; setStyles(status, { background: '#dcfce7', color: '#166534' }); }
        setTimeout(() => { closeModal(); location.reload(); }, 850);
      } else if (['cancelled', 'expired'].includes(order.status)) {
        stopPoll();
        if (status) { status.textContent = order.status === 'expired' ? '订单已过期，请关闭后重新开通。' : '订单已取消。'; setStyles(status, { background: '#fef2f2', color: '#991b1b' }); }
      }
    } catch {}
  };
  await tick(); state.poll = setInterval(tick, 2000);
}
function openPaymentModal(result, method, plan) {
  const order = result.order || result;
  const title = `${paymentLabel(method?.code || order.paymentMethod)} · ${plan?.name || order.planSnapshot?.name || '会员开通'}`;
  const amount = order.paymentMethod === 'usdt' && order.payment?.amount ? `${order.payment.amount} USDT` : money(order.amountCents);
  const modal = modalShell(title, amount);
  const payUrl = String(order.payUrl || ''); const qrUrl = String(method?.qrUrl || '');
  if (qrUrl.startsWith('https://')) {
    const img = document.createElement('img'); img.src = qrUrl; img.alt = `${paymentLabel(method.code)}支付二维码`;
    setStyles(img, { display: 'block', width: '280px', maxWidth: '80%', margin: '28px auto', borderRadius: '14px' }); modal.frameWrap.append(img);
  } else if (payUrl.startsWith('https://')) {
    const iframe = document.createElement('iframe'); iframe.src = payUrl; iframe.title = '安全支付收银台'; iframe.setAttribute('allow', 'payment *');
    setStyles(iframe, { width: '100%', height: '100%', minHeight: '430px', border: '0', background: '#fff' }); modal.frameWrap.append(iframe);
    const fallback = document.createElement('a'); fallback.href = payUrl; fallback.target = '_blank'; fallback.rel = 'noopener noreferrer'; fallback.textContent = '如果支付二维码未显示，请在新窗口打开支付页';
    setStyles(fallback, { color: '#2563eb', fontWeight: '700' }); modal.foot.append(fallback);
  } else modal.frameWrap.textContent = '当前支付方式没有可用的支付页面。';
  if (result.instructions) { const note = document.createElement('div'); note.textContent = result.instructions; setStyles(note, { marginTop: '6px' }); modal.foot.append(note); }
  void pollOrder(order.id);
}
async function createOrder(planCode, select, button) {
  const plan = (state.config?.plans || []).find((item) => item.code === planCode);
  const method = (state.config?.paymentMethods || []).find((item) => item.code === select?.value) || state.config?.paymentMethods?.[0];
  if (!plan || !method) return;
  const old = button.textContent; button.disabled = true; button.textContent = '正在打开…';
  try {
    const result = await api('/site/api/account/orders', { method: 'POST', body: JSON.stringify({ planCode, paymentMethod: method.code }) });
    openPaymentModal(result, method, plan);
  } catch (error) {
    const box = document.getElementById('paymentBox'); if (box) { box.textContent = error.message; box.className = 'notice error'; }
  } finally { button.disabled = false; button.textContent = old; }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest?.('#planList .plan button');
  if (button && /创建购买订单|开通|正在打开/.test(button.textContent || '')) {
    event.preventDefault(); event.stopImmediatePropagation();
    const card = button.closest('.plan'); const select = card?.querySelector('.payment-method-select');
    const index = [...document.querySelectorAll('#planList .plan')].indexOf(card);
    const planCode = button.dataset.commerceOpen || state.config?.plans?.[index]?.code;
    if (planCode) void createOrder(planCode, select, button); return;
  }
  const pending = event.target.closest?.('#orderList a');
  if (pending && /继续/.test(pending.textContent || '')) {
    event.preventDefault(); event.stopImmediatePropagation();
    const match = String(pending.href || '').match(/\/checkout\/(\d+)/);
    if (match) void api(`/site/api/account/orders/${match[1]}`).then((data) => {
      const order = data.order; const method = (state.config?.paymentMethods || []).find((item) => item.code === order.paymentMethod) || { code: order.paymentMethod };
      const plan = (state.config?.plans || []).find((item) => item.code === order.planCode);
      openPaymentModal(order, method, plan);
    }).catch(() => window.open(pending.href, '_blank', 'noopener,noreferrer'));
  }
}, true);

async function boot() {
  try {
    const [accountConfig, paymentConfig] = await Promise.all([api('/site/api/account/config'), api('/site/api/payments').catch(() => ({ paymentMethods: [] }))]);
    state.config = { ...accountConfig, paymentMethods: paymentConfig.paymentMethods || accountConfig.paymentMethods || [] };
    decoratePlans();
    state.observer = new MutationObserver(decoratePlans);
    state.observer.observe(document.getElementById('planList')?.parentElement || document.body, { childList: true, subtree: true });
    state.countdown = setInterval(() => {
      let expired = false;
      document.querySelectorAll('[data-promo-countdown]').forEach((item) => {
        item.textContent = `限时优惠 · 恢复原价剩余时间 ${remainingText(item.dataset.promoCountdown)}`;
        if (Date.parse(item.dataset.promoCountdown || '') <= Date.now()) expired = true;
      });
      if (expired) location.reload();
    }, 1000);
  } catch {}
}
window.addEventListener('pagehide', () => { stopPoll(); if (state.countdown) clearInterval(state.countdown); state.observer?.disconnect(); }, { once: true });
void boot();
