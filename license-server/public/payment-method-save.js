const METHOD_CONFIG = {
  wechat: { label: '微信支付', providerId: 'wechatProvider', enabledId: 'wechatEnabled', buttonId: 'saveWechatPaymentMethod', stateId: 'wechatPaymentMethodState' },
  alipay: { label: '支付宝', providerId: 'alipayProvider', enabledId: 'alipayEnabled', buttonId: 'saveAlipayPaymentMethod', stateId: 'alipayPaymentMethodState' },
};

function providerLabel(code, provider) {
  if (provider === 'zpay') return 'ZPAY / 自动回调';
  if (provider === 'manual') return '静态收款码 / 人工确认';
  if (provider === `${code}_official`) return code === 'wechat' ? '微信支付官方 API' : '支付宝官方 API';
  return String(provider || '未知');
}

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

function setState(node, text, tone = '') {
  if (!node) return;
  node.textContent = text || '';
  node.className = `config-state${tone ? ` ${tone}` : ''}`;
}

async function readPersistedState(code) {
  const [payments, official, publicPayments] = await Promise.all([
    api('/admin/api/payments'),
    api('/admin/api/official-payments'),
    api('/site/api/payments'),
  ]);
  const method = (payments.paymentMethods || []).find((item) => item.code === code) || {};
  const provider = official?.[code]?.provider || method.provider || 'manual';
  const published = (publicPayments.paymentMethods || []).some((item) => item.code === code);
  return {
    enabled: Boolean(method.enabled),
    provider,
    published,
    zpay: payments.zpay || {},
  };
}

function statusText(code, state) {
  const label = METHOD_CONFIG[code].label;
  const provider = providerLabel(code, state.provider);
  if (!state.enabled) return `${label}已保存为关闭 · 调用方式：${provider} · 官网不显示`;
  if (state.published) return `${label}已保存并已发布到官网 · 调用方式：${provider}`;
  if (state.provider === 'zpay' && (!state.zpay?.enabled || !state.zpay?.configured)) {
    return `${label}已保存，但 ZPAY 网关尚未同时满足“已启用 + PID/KEY 已配置”，所以官网暂不显示`;
  }
  return `${label}已保存，但当前支付提供方尚未达到官网发布条件`;
}

function mountMethodSave(code) {
  const config = METHOD_CONFIG[code];
  const provider = document.getElementById(config.providerId);
  const enabled = document.getElementById(config.enabledId);
  if (!provider || !enabled || document.getElementById(config.buttonId)) return;

  const actions = document.createElement('div');
  actions.className = 'provider-actions';
  actions.dataset.paymentMethodSave = code;

  const save = document.createElement('button');
  save.id = config.buttonId;
  save.type = 'button';
  save.className = 'primary';
  save.textContent = `保存${config.label}启用/调用方式`;
  actions.append(save);

  const state = document.createElement('p');
  state.id = config.stateId;
  state.className = 'config-state';
  state.textContent = '正在读取已保存的支付方式…';

  const providerLabelNode = provider.closest('label');
  if (providerLabelNode) providerLabelNode.after(actions, state);
  else provider.after(actions, state);

  const markDirty = () => setState(state, `已修改但尚未保存：${enabled.checked ? '启用' : '关闭'} · ${providerLabel(code, provider.value)}`, 'warn');
  provider.addEventListener('change', markDirty);
  enabled.addEventListener('change', markDirty);

  save.addEventListener('click', async () => {
    const selectedProvider = provider.value;
    if (!['manual', 'zpay', `${code}_official`].includes(selectedProvider)) {
      setState(state, '调用方式无效，请重新选择。', 'bad');
      return;
    }
    const original = save.textContent;
    save.disabled = true;
    save.textContent = '保存中…';
    setState(state, '正在保存并检查官网是否已生效…');
    try {
      await api(`/admin/api/official-payments/${code}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: enabled.checked, provider: selectedProvider }),
      });
      const persisted = await readPersistedState(code);
      provider.value = persisted.provider;
      enabled.checked = persisted.enabled;
      setState(state, statusText(code, persisted), persisted.enabled && persisted.published ? 'good' : persisted.enabled ? 'warn' : '');
    } catch (error) {
      setState(state, `保存失败：${error.message}`, 'bad');
    } finally {
      save.disabled = false;
      save.textContent = original;
    }
  });

  void readPersistedState(code)
    .then((persisted) => setState(state, statusText(code, persisted), persisted.enabled && persisted.published ? 'good' : persisted.enabled ? 'warn' : ''))
    .catch((error) => {
      if (error.status !== 401) setState(state, `读取保存状态失败：${error.message}`, 'bad');
    });
}

function mount() {
  for (const code of Object.keys(METHOD_CONFIG)) mountMethodSave(code);
}

mount();
const app = document.getElementById('app');
if (app) {
  const observer = new MutationObserver(() => {
    if (!app.hidden) mount();
  });
  observer.observe(app, { attributes: true, attributeFilter: ['hidden'] });
}
