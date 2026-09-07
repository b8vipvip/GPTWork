const TEST_PROVIDERS = [
  { anchor: 'testWechatOfficial', slug: 'wechat', label: '真实支付 ¥0.01', name: '微信支付', state: 'wechatOfficialState' },
  { anchor: 'testAlipayOfficial', slug: 'alipay', label: '真实支付 ¥0.01', name: '支付宝', state: 'alipayOfficialState' },
  { anchor: 'testPaypalOfficial', slug: 'paypal', label: '真实支付 0.01', name: 'PayPal', state: 'paypalOfficialState' },
  { anchor: 'testZpayConnection', slug: 'zpay-wechat', label: '微信 ¥0.01 真支付', name: 'ZPAY 微信', state: 'zpayState' },
  { anchor: 'testZpayConnection', slug: 'zpay-alipay', label: '支付宝 ¥0.01 真支付', name: 'ZPAY 支付宝', state: 'zpayState' },
  { anchor: 'testOkxConnection', slug: 'usdt', label: '0.01 USDT 真到账', name: 'USDT / OKX', state: 'okxState' },
];

const activePolls = new Map();

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body;
}

function globalMessage(text, good = false) {
  const node = document.getElementById('paymentSettingsMessage');
  if (!node) return;
  node.textContent = text;
  node.className = `message ${good ? 'good' : ''}`.trim();
}

function statusLabel(status) {
  return ({ awaiting: '等待付款/到账', settled: '真实支付链路验证成功', cancelled: '已取消', expired: '已过期', error: '测试失败' })[status] || status;
}

function renderOrder(order, provider, good = false) {
  const state = document.getElementById(provider.state);
  const details = `测试单 #${order.id} · ${order.amount} ${order.currency} · ${statusLabel(order.status)}`;
  const suffix = order.providerMessage ? ` · ${order.providerMessage}` : order.lastError ? ` · 错误：${order.lastError}` : '';
  if (state) state.textContent = `${state.textContent.split(' · 测试单 #')[0]} · ${details}${suffix}`;
  globalMessage(`${provider.name}：${details}${suffix}`, good);
}

function stopPoll(id) {
  const timer = activePolls.get(id);
  if (timer) clearInterval(timer);
  activePolls.delete(id);
}

function pollOrder(order, provider) {
  stopPoll(order.id);
  const started = Date.now();
  const check = async () => {
    try {
      const data = await api(`/admin/api/payment-tests/${order.id}?refresh=1`);
      const current = data.testOrder;
      const done = ['settled', 'cancelled', 'expired', 'error'].includes(current.status);
      renderOrder(current, provider, current.status === 'settled');
      if (done || Date.now() - started > 60 * 60 * 1000) stopPoll(order.id);
    } catch (error) {
      globalMessage(`${provider.name} 测试状态读取失败：${error.message}`);
    }
  };
  void check();
  activePolls.set(order.id, setInterval(check, provider.slug === 'usdt' ? 5000 : 2500));
}

async function createRealTest(provider, button) {
  const unit = provider.slug === 'usdt' ? '0.01 USDT' : provider.slug === 'paypal' ? '0.01（按当前 PayPal 币种）' : '¥0.01';
  if (!window.confirm(`将创建 ${provider.name} 的真实支付测试订单，金额 ${unit}。\n\n继续后需要你在真实收银台完成付款；测试付款不会开通会员，但资金会按当前正式/沙箱环境处理。是否继续？`)) return;

  button.disabled = true;
  const popup = window.open('about:blank', '_blank');
  if (popup) {
    try { popup.opener = null; popup.document.title = '正在创建支付测试订单…'; popup.document.body.textContent = '正在创建 0.01 支付测试订单…'; } catch {}
  }
  globalMessage(`正在创建 ${provider.name} 0.01 真实支付测试订单…`);
  try {
    const data = await api(`/admin/api/payment-tests/${provider.slug}`, { method: 'POST', body: '{}' });
    const order = data.testOrder;
    renderOrder(order, provider);
    if (popup && order.payUrl) popup.location.replace(order.payUrl);
    else if (order.payUrl) window.open(order.payUrl, '_blank', 'noopener,noreferrer');
    pollOrder(order, provider);
  } catch (error) {
    if (popup) popup.close();
    globalMessage(`${provider.name} 真实支付测试订单创建失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function injectProvider(provider, index) {
  const anchor = document.getElementById(provider.anchor);
  if (!anchor || document.querySelector(`[data-payment-test="${provider.slug}"]`)) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.paymentTest = provider.slug;
  button.textContent = provider.label;
  button.title = '创建 0.01 的真实支付/到账订单，完成端到端回调验证；不会开通会员';
  button.addEventListener('click', () => void createRealTest(provider, button));
  anchor.insertAdjacentElement('afterend', button);
  if (provider.anchor === 'testZpayConnection' && index > 0) {
    const first = document.querySelector('[data-payment-test="zpay-wechat"]');
    if (first) first.insertAdjacentElement('afterend', button);
  }
}

async function resumeFromQuery() {
  const id = Number(new URLSearchParams(location.search).get('paymentTest') || 0);
  if (!Number.isInteger(id) || id < 1) return;
  try {
    const data = await api(`/admin/api/payment-tests/${id}?refresh=1`);
    const order = data.testOrder;
    const provider = TEST_PROVIDERS.find((item) => ({
      zpay_wechat: 'zpay-wechat', zpay_alipay: 'zpay-alipay', wechat_official: 'wechat',
      alipay_official: 'alipay', paypal_official: 'paypal', okx_usdt: 'usdt',
    })[order.provider] === item.slug);
    if (provider) {
      renderOrder(order, provider, order.status === 'settled');
      if (order.status === 'awaiting') pollOrder(order, provider);
    }
  } catch {}
}

function init() {
  TEST_PROVIDERS.forEach(injectProvider);
  void resumeFromQuery();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
