const $ = (id) => document.getElementById(id);
const app = $('app');
const message = $('paymentSettingsMessage');
let loaded = false;
let planRows = [];
let officialState = { wechat: {}, alipay: {}, paypal: {} };

function setMessage(value, tone = '') {
  if (!message) return;
  message.textContent = value || '';
  message.className = `message ${tone}`.trim();
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

function byCode(rows, code) {
  return (rows || []).find((row) => row.code === code) || {
    code, enabled: false, payUrl: '', instructions: '', qrConfigured: false, crypto: null,
  };
}

function renderQrState(code, method) {
  const state = $(`${code}QrState`);
  if (!state) return;
  state.replaceChildren();
  if (!method.qrConfigured || !method.qrUrl) {
    state.textContent = '未上传二维码';
    return;
  }
  state.append(document.createTextNode('二维码已配置 · '));
  const link = document.createElement('a');
  link.href = `${method.qrUrl}?t=${Date.now()}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '预览';
  state.append(link);
}

function renderPlanPrices(prices = {}) {
  const container = $('usdtPlanPrices');
  if (!container) return;
  container.replaceChildren();
  for (const plan of planRows) {
    const label = document.createElement('label');
    label.textContent = `${plan.name} · USDT`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0.000001';
    input.step = '0.000001';
    input.placeholder = '例如 3.00';
    input.value = prices[plan.code] || '';
    input.dataset.planCode = plan.code;
    label.append(input);
    container.append(label);
  }
  if (!planRows.length) container.textContent = '当前没有会员套餐。';
}

function okxStatusText(okx = {}) {
  const parts = [okx.configured ? `凭据已配置${okx.apiKeyHint ? `（${okx.apiKeyHint}）` : ''}` : '凭据未配置'];
  parts.push(okx.enabled ? '自动核对已启用' : '自动核对未启用');
  if (okx.lastSuccessAt) parts.push(`最近成功检查 ${new Date(okx.lastSuccessAt).toLocaleString()}`);
  else if (okx.lastCheckAt) parts.push(`最近检查 ${new Date(okx.lastCheckAt).toLocaleString()}`);
  if (okx.lastMatchedOrderId) parts.push(`最近自动匹配订单 #${okx.lastMatchedOrderId}`);
  if (okx.lastError) parts.push(`错误：${okx.lastError}`);
  return parts.join(' · ');
}

function officialStatusText(code, config = {}) {
  const parts = [config.configured ? '凭据已配置' : '凭据未配置'];
  if (code === 'wechat') {
    if (config.appId) parts.push(`AppID ${config.appId}`);
    if (config.mchIdHint) parts.push(`MchID ${config.mchIdHint}`);
    if (config.merchantSerialNo) parts.push(`商户证书 ${config.merchantSerialNo}`);
    if (config.platformSerialNo) parts.push(`平台序列号 ${config.platformSerialNo}`);
  } else if (code === 'alipay') {
    if (config.appId) parts.push(`AppID ${config.appId}`);
    parts.push(config.sandbox ? '沙箱环境' : '正式环境');
  } else if (code === 'paypal') {
    if (config.clientIdHint) parts.push(`Client ID ${config.clientIdHint}`);
    parts.push(config.sandbox ? 'Sandbox' : 'Live');
    if (config.currency) parts.push(config.currency);
  }
  if (config.lastTestAt) parts.push(`最近测试 ${new Date(config.lastTestAt).toLocaleString()}`);
  if (config.lastError) parts.push(`错误：${config.lastError}`);
  return parts.join(' · ');
}

function setOfficialBadge(code, config = {}) {
  const badge = $(`${code}OfficialBadge`);
  if (!badge) return;
  badge.className = `provider-badge${config.configured ? ' good' : config.lastError ? ' bad' : ''}`;
  badge.textContent = config.configured ? '已配置' : config.lastError ? '配置异常' : '未配置';
}

function syncProviderFields(code) {
  if (!['wechat', 'alipay'].includes(code)) return;
  const provider = $(`${code}Provider`)?.value || 'manual';
  const official = document.querySelector(`[data-provider-fields="${code}_official"]`);
  const legacy = document.querySelector(`[data-provider-fields="${code}_legacy"]`);
  if (official) official.hidden = provider !== `${code}_official`;
  if (legacy) legacy.hidden = provider !== 'manual';
}

function renderOfficial(configs = {}) {
  officialState = {
    wechat: configs.wechat || {},
    alipay: configs.alipay || {},
    paypal: configs.paypal || {},
  };

  const wechat = officialState.wechat;
  if ($('wechatOfficialAppId')) $('wechatOfficialAppId').value = wechat.appId || '';
  if ($('wechatOfficialMchId')) $('wechatOfficialMchId').value = '';
  if ($('wechatOfficialMchId')) $('wechatOfficialMchId').placeholder = wechat.mchIdHint ? `已保存 ${wechat.mchIdHint}；填写可替换` : '190000....';
  if ($('wechatOfficialMerchantSerial')) $('wechatOfficialMerchantSerial').value = wechat.merchantSerialNo || '';
  if ($('wechatOfficialPlatformSerial')) $('wechatOfficialPlatformSerial').value = wechat.platformSerialNo || '';
  if ($('wechatOfficialPrivateKey')) $('wechatOfficialPrivateKey').value = '';
  if ($('wechatOfficialApiV3Key')) $('wechatOfficialApiV3Key').value = '';
  if ($('wechatOfficialPlatformKey')) $('wechatOfficialPlatformKey').value = '';
  if ($('wechatOfficialState')) $('wechatOfficialState').textContent = officialStatusText('wechat', wechat);
  setOfficialBadge('wechat', wechat);

  const alipay = officialState.alipay;
  if ($('alipayOfficialAppId')) $('alipayOfficialAppId').value = alipay.appId || '';
  if ($('alipayOfficialSandbox')) $('alipayOfficialSandbox').checked = Boolean(alipay.sandbox);
  if ($('alipayOfficialPrivateKey')) $('alipayOfficialPrivateKey').value = '';
  if ($('alipayOfficialPublicKey')) $('alipayOfficialPublicKey').value = '';
  if ($('alipayOfficialState')) $('alipayOfficialState').textContent = officialStatusText('alipay', alipay);
  setOfficialBadge('alipay', alipay);

  const paypal = officialState.paypal;
  if ($('paypalOfficialEnvironment')) $('paypalOfficialEnvironment').value = paypal.sandbox === false ? 'live' : 'sandbox';
  if ($('paypalOfficialCurrency')) $('paypalOfficialCurrency').value = paypal.currency || 'CNY';
  if ($('paypalOfficialClientId')) {
    $('paypalOfficialClientId').value = '';
    $('paypalOfficialClientId').placeholder = paypal.clientIdHint ? `已保存 ${paypal.clientIdHint}；填写可替换` : 'PayPal Client ID';
  }
  if ($('paypalOfficialClientSecret')) $('paypalOfficialClientSecret').value = '';
  if ($('paypalOfficialState')) $('paypalOfficialState').textContent = officialStatusText('paypal', paypal);
  setOfficialBadge('paypal', paypal);

  if ($('wechatProvider') && wechat.provider) $('wechatProvider').value = wechat.provider;
  if ($('alipayProvider') && alipay.provider) $('alipayProvider').value = alipay.provider;
  syncProviderFields('wechat');
  syncProviderFields('alipay');
}

function render(data, official = {}) {
  const rows = data.paymentMethods || [];
  for (const code of ['wechat', 'alipay', 'usdt']) {
    const method = byCode(rows, code);
    const enabled = $(`${code}Enabled`);
    const url = $(`${code}Url`);
    const instructions = $(`${code}Instructions`);
    if (enabled) enabled.checked = Boolean(method.enabled);
    if (url) url.value = method.payUrl || '';
    if (instructions) instructions.value = method.instructions || '';
    if (code !== 'usdt' && $(`${code}Provider`)) {
      const officialProvider = official?.[code]?.provider;
      $(`${code}Provider`).value = officialProvider || (method.provider === 'zpay' ? 'zpay' : 'manual');
    }
    renderQrState(code, method);
    if (code === 'usdt') {
      if ($('usdtNetwork')) $('usdtNetwork').value = method.crypto?.network || '';
      if ($('usdtAddress')) $('usdtAddress').value = method.crypto?.address || '';
      if ($('usdtMemo')) $('usdtMemo').value = method.crypto?.memo || '';
    }
  }
  const paypalMethod = byCode(rows, 'paypal');
  if ($('paypalEnabled')) $('paypalEnabled').checked = Boolean(paypalMethod.enabled);
  if ($('paypalInstructions')) $('paypalInstructions').value = paypalMethod.instructions || $('paypalInstructions').value || '';

  renderPlanPrices(data.usdtPlanPrices || byCode(rows, 'usdt').planPrices || {});
  const okx = data.okx || {};
  if ($('okxAutoEnabled')) $('okxAutoEnabled').checked = Boolean(okx.enabled);
  if ($('okxPollSeconds')) $('okxPollSeconds').value = okx.pollSeconds || 15;
  if ($('usdtOrderTtlMinutes')) $('usdtOrderTtlMinutes').value = okx.orderTtlMinutes || 120;
  if ($('okxAllowInternalTransfers')) $('okxAllowInternalTransfers').checked = okx.allowInternalTransfers !== false;
  if ($('okxApiKey')) $('okxApiKey').value = '';
  if ($('okxSecretKey')) $('okxSecretKey').value = '';
  if ($('okxPassphrase')) $('okxPassphrase').value = '';
  if ($('okxState')) $('okxState').textContent = okxStatusText(okx);

  const zpay = data.zpay || {};
  if ($('zpayEnabled')) $('zpayEnabled').checked = Boolean(zpay.enabled);
  if ($('zpayPid')) $('zpayPid').value = '';
  if ($('zpayKey')) $('zpayKey').value = '';
  if ($('zpayAlipayCid')) $('zpayAlipayCid').value = zpay.alipayCid || '';
  if ($('zpayWechatCid')) $('zpayWechatCid').value = zpay.wechatCid || '';
  if ($('zpayState')) {
    const parts = [zpay.configured ? `凭据已配置${zpay.pidHint ? `（${zpay.pidHint}）` : ''}` : '凭据未配置', zpay.enabled ? '网关已启用' : '网关未启用'];
    if (zpay.lastTestAt) parts.push(`最近测试 ${new Date(zpay.lastTestAt).toLocaleString()}`);
    if (zpay.lastError) parts.push(`错误：${zpay.lastError}`);
    $('zpayState').textContent = parts.join(' · ');
  }
  renderOfficial(official);
}

async function loadPayments(force = false) {
  if (loaded && !force) return;
  try {
    const [data, official, plans] = await Promise.all([
      api('/admin/api/payments'),
      api('/admin/api/official-payments'),
      api('/admin/api/account/plans'),
    ]);
    planRows = plans.plans || [];
    loaded = true;
    render(data, official);
  } catch (error) {
    if (!app?.hidden) setMessage(`支付配置读取失败：${error.message}`, 'bad');
  }
}

async function saveMethod(code) {
  const provider = code !== 'usdt' ? ($(`${code}Provider`)?.value || 'manual') : '';
  const body = {
    enabled: Boolean($(`${code}Enabled`)?.checked),
    payUrl: $(`${code}Url`)?.value.trim() || '',
    instructions: $(`${code}Instructions`)?.value.trim() || '',
    ...(code !== 'usdt' && ['manual', 'zpay'].includes(provider) ? { provider } : {}),
  };
  if (code === 'usdt') {
    body.crypto = {
      asset: 'USDT',
      network: $('usdtNetwork').value.trim(),
      address: $('usdtAddress').value.trim(),
      memo: $('usdtMemo').value.trim(),
    };
  }
  return api(`/admin/api/payments/${code}`, { method: 'PUT', body: JSON.stringify(body) });
}

function collectUsdtPrices() {
  const prices = {};
  for (const input of document.querySelectorAll('#usdtPlanPrices input[data-plan-code]')) {
    prices[input.dataset.planCode] = input.value.trim();
  }
  return prices;
}

async function savePayments() {
  const action = $('saveAdvancedPayments');
  if (!action) return;
  action.disabled = true;
  setMessage('正在保存通用支付配置与 USDT 套餐价格…');
  try {
    await Promise.all(['wechat', 'alipay', 'usdt'].map(saveMethod));
    await api('/admin/api/payments/usdt/prices', { method: 'PUT', body: JSON.stringify({ prices: collectUsdtPrices() }) });
    loaded = false;
    await loadPayments(true);
    setMessage('通用支付配置已保存。官方接口凭据请在各支付卡片中单独保存。', 'good');
  } catch (error) {
    setMessage(`保存失败：${error.message}`, 'bad');
  } finally {
    action.disabled = false;
  }
}

function optionalSecret(id, key, transform = (value) => value) {
  const value = $(id)?.value || '';
  return value ? { [key]: transform(value) } : {};
}

async function saveOfficial(code) {
  const action = $(`save${code[0].toUpperCase()}${code.slice(1)}Official`);
  if (!action) return;
  action.disabled = true;
  setMessage(`正在加密保存${code === 'wechat' ? '微信支付' : code === 'alipay' ? '支付宝' : 'PayPal'}官方接口配置…`);
  try {
    let body;
    if (code === 'wechat') {
      body = {
        enabled: Boolean($('wechatEnabled')?.checked),
        provider: 'wechat_official',
        instructions: $('wechatInstructions')?.value.trim() || '',
        appId: $('wechatOfficialAppId')?.value.trim() || '',
        ...( $('wechatOfficialMchId')?.value.trim() ? { mchId: $('wechatOfficialMchId').value.trim() } : {}),
        merchantSerialNo: $('wechatOfficialMerchantSerial')?.value.trim() || '',
        platformSerialNo: $('wechatOfficialPlatformSerial')?.value.trim() || '',
        ...optionalSecret('wechatOfficialPrivateKey', 'merchantPrivateKeyPem'),
        ...optionalSecret('wechatOfficialApiV3Key', 'apiV3Key'),
        ...optionalSecret('wechatOfficialPlatformKey', 'platformPublicKeyPem'),
      };
    } else if (code === 'alipay') {
      body = {
        enabled: Boolean($('alipayEnabled')?.checked),
        provider: 'alipay_official',
        instructions: $('alipayInstructions')?.value.trim() || '',
        appId: $('alipayOfficialAppId')?.value.trim() || '',
        sandbox: Boolean($('alipayOfficialSandbox')?.checked),
        ...optionalSecret('alipayOfficialPrivateKey', 'appPrivateKeyPem'),
        ...optionalSecret('alipayOfficialPublicKey', 'alipayPublicKeyPem'),
      };
    } else {
      body = {
        enabled: Boolean($('paypalEnabled')?.checked),
        instructions: $('paypalInstructions')?.value.trim() || '',
        sandbox: $('paypalOfficialEnvironment')?.value !== 'live',
        currency: ($('paypalOfficialCurrency')?.value.trim() || 'CNY').toUpperCase(),
        ...optionalSecret('paypalOfficialClientId', 'clientId', (value) => value.trim()),
        ...optionalSecret('paypalOfficialClientSecret', 'clientSecret'),
      };
    }
    const data = await api(`/admin/api/official-payments/${code}`, { method: 'PUT', body: JSON.stringify(body) });
    officialState[code] = data.config || {};
    loaded = false;
    await loadPayments(true);
    setMessage(`${code === 'wechat' ? '微信支付' : code === 'alipay' ? '支付宝' : 'PayPal'}官方接口配置已保存。`, data.config?.configured ? 'good' : '');
  } catch (error) {
    setMessage(`官方接口配置保存失败：${error.message}`, 'bad');
  } finally {
    action.disabled = false;
  }
}

async function testOfficial(code) {
  const action = $(`test${code[0].toUpperCase()}${code.slice(1)}Official`);
  if (!action) return;
  action.disabled = true;
  setMessage(code === 'alipay' ? '正在验证支付宝 RSA2 密钥配置…' : `正在测试 ${code === 'wechat' ? '微信支付' : 'PayPal'} 官方接口连接…`);
  try {
    const data = await api(`/admin/api/official-payments/${code}/test`, { method: 'POST', body: '{}' });
    officialState[code] = data.config || officialState[code];
    renderOfficial(officialState);
    setMessage(code === 'alipay' ? '支付宝 RSA2 配置验证通过。' : `${code === 'wechat' ? '微信支付' : 'PayPal'}官方接口连接成功。`, 'good');
  } catch (error) {
    loaded = false;
    await loadPayments(true).catch(() => {});
    setMessage(`官方接口测试失败：${error.message}`, 'bad');
  } finally {
    action.disabled = false;
  }
}

async function clearOfficial(code) {
  const label = code === 'wechat' ? '微信支付' : code === 'alipay' ? '支付宝' : 'PayPal';
  if (!window.confirm(`清除服务端保存的${label}官方接口凭据并关闭该支付方式？`)) return;
  const action = $(`clear${code[0].toUpperCase()}${code.slice(1)}Official`);
  if (!action) return;
  action.disabled = true;
  try {
    const body = {
      clearCredentials: true,
      enabled: false,
      ...(code === 'wechat' ? { provider: 'manual' } : code === 'alipay' ? { provider: 'manual' } : {}),
    };
    await api(`/admin/api/official-payments/${code}`, { method: 'PUT', body: JSON.stringify(body) });
    loaded = false;
    await loadPayments(true);
    setMessage(`${label}官方接口凭据已清除。`, 'good');
  } catch (error) {
    setMessage(`清除失败：${error.message}`, 'bad');
  } finally {
    action.disabled = false;
  }
}

async function saveZpaySettings() {
  const action = $('saveZpaySettings');
  action.disabled = true;
  setMessage('正在加密保存 ZPAY 配置…');
  try {
    const body = {
      enabled: $('zpayEnabled').checked,
      alipayCid: $('zpayAlipayCid').value.trim(),
      wechatCid: $('zpayWechatCid').value.trim(),
      ...($('zpayPid').value.trim() ? { pid: $('zpayPid').value.trim() } : {}),
      ...($('zpayKey').value ? { key: $('zpayKey').value } : {}),
    };
    const data = await api('/admin/api/payments/zpay', { method: 'PUT', body: JSON.stringify(body) });
    $('zpayPid').value = '';
    $('zpayKey').value = '';
    loaded = false;
    await loadPayments(true);
    setMessage(data.zpay?.configured ? 'ZPAY 配置已保存。现在可把支付宝/微信的调用方式切换为 ZPAY。' : 'ZPAY 基础设置已保存，但商户 ID / 密钥尚未配置完整。', data.zpay?.configured ? 'good' : '');
  } catch (error) { setMessage(`ZPAY 配置保存失败：${error.message}`, 'bad'); }
  finally { action.disabled = false; }
}

async function testZpayConnection() {
  const action = $('testZpayConnection');
  action.disabled = true;
  setMessage('正在读取 ZPAY 商户余额以验证 API 凭据…');
  try {
    const data = await api('/admin/api/payments/zpay/test', { method: 'POST', body: '{}' });
    loaded = false;
    await loadPayments(true);
    setMessage(`ZPAY API 连接成功${data.balance !== '' ? `，账户余额 ${data.balance}` : ''}。`, 'good');
  } catch (error) { setMessage(`ZPAY API 测试失败：${error.message}`, 'bad'); }
  finally { action.disabled = false; }
}

async function clearZpayCredentials() {
  if (!window.confirm('清除服务端保存的 ZPAY 商户 ID 与商户密钥，并关闭 ZPAY 网关？')) return;
  const action = $('clearZpayCredentials');
  action.disabled = true;
  try {
    await api('/admin/api/payments/zpay', { method: 'PUT', body: JSON.stringify({ clearCredentials: true }) });
    loaded = false;
    await loadPayments(true);
    setMessage('ZPAY 凭据已清除，网关已关闭。', 'good');
  } catch (error) { setMessage(`清除 ZPAY 凭据失败：${error.message}`, 'bad'); }
  finally { action.disabled = false; }
}

async function saveOkxSettings() {
  const action = $('saveOkxSettings');
  action.disabled = true;
  setMessage('正在加密保存 OKX 只读 API 配置…');
  try {
    const body = {
      enabled: $('okxAutoEnabled').checked,
      pollSeconds: Number($('okxPollSeconds').value),
      orderTtlMinutes: Number($('usdtOrderTtlMinutes').value),
      allowInternalTransfers: $('okxAllowInternalTransfers').checked,
      ...($('okxApiKey').value.trim() ? { apiKey: $('okxApiKey').value.trim() } : {}),
      ...($('okxSecretKey').value ? { secretKey: $('okxSecretKey').value } : {}),
      ...($('okxPassphrase').value ? { passphrase: $('okxPassphrase').value } : {}),
    };
    const data = await api('/admin/api/payments/usdt/okx', { method: 'PUT', body: JSON.stringify(body) });
    $('okxApiKey').value = '';
    $('okxSecretKey').value = '';
    $('okxPassphrase').value = '';
    $('okxState').textContent = okxStatusText(data.okx || {});
    setMessage('OKX 配置已保存。只有凭据完整且“自动核对”启用时才会自动开通。', 'good');
  } catch (error) {
    setMessage(`OKX 配置保存失败：${error.message}`, 'bad');
  } finally {
    action.disabled = false;
  }
}

async function testOkxConnection() {
  const action = $('testOkxConnection');
  action.disabled = true;
  setMessage('正在通过只读 API 读取一条 USDT 充值记录…');
  try {
    const data = await api('/admin/api/payments/usdt/okx/test', { method: 'POST', body: '{}' });
    $('okxState').textContent = okxStatusText(data.okx || {});
    setMessage(`OKX API 连接成功，返回 ${Number(data.sampleCount || 0)} 条样本记录。`, 'good');
  } catch (error) {
    setMessage(`OKX API 测试失败：${error.message}`, 'bad');
  } finally {
    action.disabled = false;
  }
}

async function checkOkxNow() {
  const action = $('checkOkxNow');
  action.disabled = true;
  setMessage('正在立即核对待支付 USDT 订单…');
  try {
    const data = await api('/admin/api/payments/usdt/okx/check', { method: 'POST', body: '{}' });
    setMessage(`检查完成：待核对 ${Number(data.checkedOrders || 0)} 个订单，读取 ${Number(data.deposits || 0)} 笔充值，自动开通 ${Number(data.settled || 0)} 个，歧义 ${Number(data.ambiguous || 0)} 个。`, 'good');
    loaded = false;
    await loadPayments(true);
  } catch (error) {
    setMessage(`立即检查失败：${error.message}`, 'bad');
  } finally {
    action.disabled = false;
  }
}

async function clearOkxCredentials() {
  if (!window.confirm('清除服务端已保存的 OKX API Key、Secret Key 与 Passphrase？自动核对将同时关闭。')) return;
  const action = $('clearOkxCredentials');
  action.disabled = true;
  try {
    const data = await api('/admin/api/payments/usdt/okx', { method: 'PUT', body: JSON.stringify({ clearCredentials: true, enabled: false }) });
    $('okxAutoEnabled').checked = false;
    $('okxState').textContent = okxStatusText(data.okx || {});
    setMessage('OKX 凭据已清除，自动核对已关闭。', 'good');
  } catch (error) {
    setMessage(`清除失败：${error.message}`, 'bad');
  } finally {
    action.disabled = false;
  }
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('请先选择二维码图片'));
    if (file.size > 1024 * 1024) return reject(new Error('二维码图片必须小于 1 MB'));
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return reject(new Error('仅支持 PNG、JPEG 或 WebP 图片'));
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取二维码图片失败'));
    reader.readAsDataURL(file);
  });
}

async function uploadQr(code) {
  const action = $(`${code}QrUpload`);
  action.disabled = true;
  setMessage('正在上传二维码…');
  try {
    const dataUrl = await fileAsDataUrl($(`${code}QrFile`)?.files?.[0]);
    await api(`/admin/api/payments/${code}/qr`, { method: 'POST', body: JSON.stringify({ dataUrl }) });
    $(`${code}QrFile`).value = '';
    loaded = false;
    await loadPayments(true);
    setMessage('二维码已保存到服务端。', 'good');
  } catch (error) {
    setMessage(`二维码上传失败：${error.message}`, 'bad');
  } finally {
    action.disabled = false;
  }
}

async function deleteQr(code) {
  if (!window.confirm('删除这个支付方式的收款二维码？')) return;
  const action = $(`${code}QrDelete`);
  action.disabled = true;
  try {
    await api(`/admin/api/payments/${code}/qr`, { method: 'DELETE', body: '{}' });
    loaded = false;
    await loadPayments(true);
    setMessage('二维码已删除。', 'good');
  } catch (error) {
    setMessage(`删除失败：${error.message}`, 'bad');
  } finally {
    action.disabled = false;
  }
}

$('saveAdvancedPayments')?.addEventListener('click', () => void savePayments());
$('saveZpaySettings')?.addEventListener('click', () => void saveZpaySettings());
$('testZpayConnection')?.addEventListener('click', () => void testZpayConnection());
$('clearZpayCredentials')?.addEventListener('click', () => void clearZpayCredentials());
$('saveOkxSettings')?.addEventListener('click', () => void saveOkxSettings());
$('testOkxConnection')?.addEventListener('click', () => void testOkxConnection());
$('checkOkxNow')?.addEventListener('click', () => void checkOkxNow());
$('clearOkxCredentials')?.addEventListener('click', () => void clearOkxCredentials());
for (const code of ['wechat', 'alipay', 'usdt']) {
  $(`${code}QrUpload`)?.addEventListener('click', () => void uploadQr(code));
  $(`${code}QrDelete`)?.addEventListener('click', () => void deleteQr(code));
}
for (const code of ['wechat', 'alipay', 'paypal']) {
  $(`save${code[0].toUpperCase()}${code.slice(1)}Official`)?.addEventListener('click', () => void saveOfficial(code));
  $(`test${code[0].toUpperCase()}${code.slice(1)}Official`)?.addEventListener('click', () => void testOfficial(code));
  $(`clear${code[0].toUpperCase()}${code.slice(1)}Official`)?.addEventListener('click', () => void clearOfficial(code));
}
for (const code of ['wechat', 'alipay']) {
  $(`${code}Provider`)?.addEventListener('change', () => syncProviderFields(code));
}

if (app) {
  const observer = new MutationObserver(() => { if (!app.hidden) void loadPayments(true); });
  observer.observe(app, { attributes: true, attributeFilter: ['hidden'] });
  if (!app.hidden) void loadPayments(true);
}
