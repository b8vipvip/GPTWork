const $ = (id) => document.getElementById(id);
const el = {
  authShell: $('authShell'), appShell: $('appShell'), authMessage: $('authMessage'),
  showLogin: $('showLogin'), showRegister: $('showRegister'), showForgot: $('showForgot'),
  loginForm: $('loginForm'), loginEmail: $('loginEmail'), loginPassword: $('loginPassword'),
  registerForm: $('registerForm'), registerEmail: $('registerEmail'), registerPassword: $('registerPassword'), registerPassword2: $('registerPassword2'),
  verifyForm: $('verifyForm'), verifyEmailText: $('verifyEmailText'), verifyCode: $('verifyCode'), resendVerification: $('resendVerification'),
  forgotForm: $('forgotForm'), forgotEmail: $('forgotEmail'),
  resetForm: $('resetForm'), resetEmailText: $('resetEmailText'), resetCode: $('resetCode'), resetPassword: $('resetPassword'),
  deviceReplaceForm: $('deviceReplaceForm'), deviceReplaceHint: $('deviceReplaceHint'), deviceReplaceList: $('deviceReplaceList'), cancelDeviceReplace: $('cancelDeviceReplace'),
  accountEmail: $('accountEmail'), accountTier: $('accountTier'), accountExpiry: $('accountExpiry'), accountUsage: $('accountUsage'), accountCenter: $('accountCenter'), accountLogout: $('accountLogout'), accountUpgrade: $('accountUpgrade'),
  enabled: $('enabled'),
};

const ACCOUNT_SNAPSHOT_KEY = 'gptlockAccountSnapshot';
const STATE_TIMEOUT_MS = 2500;

let verificationEmail = '';
let resetEmail = '';
let deviceLimitDetails = null;
let accountAuthenticated = false;

function withTimeout(promise, ms = STATE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('账户状态刷新超时 / Account state refresh timed out')), ms)),
  ]);
}

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

function readCachedAccount() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(ACCOUNT_SNAPSHOT_KEY, (stored) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      const account = stored?.[ACCOUNT_SNAPSHOT_KEY];
      resolve(account && typeof account === 'object' ? account : null);
    });
  });
}

function localDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function setMessage(text, tone = '') {
  if (!el.authMessage) return;
  el.authMessage.textContent = text || '';
  el.authMessage.className = `auth-message ${tone}`.trim();
}

function showPanel(name) {
  const map = {
    login: el.loginForm,
    register: el.registerForm,
    verify: el.verifyForm,
    forgot: el.forgotForm,
    reset: el.resetForm,
    deviceReplace: el.deviceReplaceForm,
  };
  for (const panel of Object.values(map)) if (panel) panel.hidden = true;
  if (map[name]) map[name].hidden = false;
  el.showLogin?.classList.toggle('active', name === 'login');
  el.showRegister?.classList.toggle('active', name === 'register' || name === 'verify');
  el.showForgot?.classList.toggle('active', name === 'forgot' || name === 'reset');
  setMessage('');
}

function showAuthScreen(reason = '') {
  if (!el.authShell || !el.appShell) return;
  el.appShell.hidden = true;
  el.authShell.hidden = false;
  showPanel('login');
  if (reason) setMessage(reason, 'bad');
}

function showAppScreen() {
  if (el.authShell) el.authShell.hidden = true;
  if (el.appShell) el.appShell.hidden = false;
}

function renderDeviceReplacement(details) {
  deviceLimitDetails = details || {};
  const required = Math.max(1, Number(deviceLimitDetails.requiredReleaseCount || 1));
  el.deviceReplaceHint.textContent = `当前最多允许 ${deviceLimitDetails.limit || '—'} 台设备。请选择至少 ${required} 台不再使用的旧设备；释放后这些设备上的 GPTWork 会话立即失效。`;
  el.deviceReplaceList.textContent = '';
  for (const device of deviceLimitDetails.devices || []) {
    const label = document.createElement('label');
    label.className = 'device-replace-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = String(device.id);
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = device.platform || '未知设备';
    const meta = document.createElement('small');
    meta.textContent = `最后使用 ${localDate(device.lastSeenAt)} · 活跃会话 ${device.activeSessions || 0}`;
    copy.append(title, meta);
    label.append(checkbox, copy);
    el.deviceReplaceList.append(label);
  }
}

async function finishLogin(replaceDeviceRecordIds = []) {
  const account = await sendMessage({
    type: 'GPTLOCK_ACCOUNT_LOGIN',
    email: el.loginEmail.value.trim(),
    password: el.loginPassword.value,
    replaceDeviceRecordIds,
  });
  el.loginPassword.value = '';
  deviceLimitDetails = null;
  setMessage('登录成功。', 'good');
  await refreshGate();
  window.dispatchEvent(new CustomEvent('gptlock-account-changed'));
  return account;
}

function renderAccount(account) {
  const authenticated = Boolean(account?.authenticated);
  accountAuthenticated = authenticated;
  showAppScreen();

  if (!authenticated) {
    if (el.accountEmail) el.accountEmail.textContent = '未登录';
    if (el.accountTier) el.accountTier.textContent = '登录/注册后可启用功能';
    if (el.accountExpiry) el.accountExpiry.textContent = '权益有效期 —';
    if (el.accountUsage) el.accountUsage.textContent = '设备/窗口 —';
    if (el.accountCenter) el.accountCenter.textContent = '登录 / 注册';
    if (el.accountLogout) el.accountLogout.hidden = true;
    if (el.accountUpgrade) el.accountUpgrade.hidden = true;
    window.dispatchEvent(new CustomEvent('gptlock-entitlement-state', {
      detail: { authenticated: false, active: false },
    }));
    return;
  }

  const user = account.user || {};
  const entitlement = account.entitlement || {};
  const sourceName = account.level?.name || entitlement.level?.name || '普通用户';
  if (el.accountEmail) el.accountEmail.textContent = user.email || '—';
  if (el.accountTier) el.accountTier.textContent = sourceName;
  if (el.accountExpiry) el.accountExpiry.textContent = `权益有效期 ${localDate(entitlement.expiresAt)}`;
  const usage = entitlement.usage || {};
  const limits = entitlement.limits || {};
  if (el.accountUsage) {
    el.accountUsage.textContent = `设备 ${usage.devices ?? 0}/${limits.devices ?? 0} · 窗口 ${usage.windows ?? 0}/${limits.windows ?? 0}`;
    el.accountUsage.title = account.lastError ? `最近一次状态刷新失败：${account.lastError}` : '';
  }
  if (el.accountCenter) el.accountCenter.textContent = '账户中心';
  if (el.accountLogout) el.accountLogout.hidden = false;
  if (el.accountUpgrade) el.accountUpgrade.hidden = false;
  if (el.enabled) {
    if (!entitlement.active) el.enabled.title = '当前使用时长已到期，请签到、分享或升级用户等级';
    else el.enabled.title = `GPTWork 功能可用；当前等级最多 ${limits.windows ?? 1} 个同时窗口`;
  }
  window.dispatchEvent(new CustomEvent('gptlock-entitlement-state', {
    detail: { authenticated, active: Boolean(entitlement.active) },
  }));
}

async function refreshGate() {
  let cachedAccount = null;
  try {
    cachedAccount = await readCachedAccount();
    if (cachedAccount) renderAccount(cachedAccount);
  } catch {
    // Live background state below remains authoritative when local storage is unavailable.
  }

  try {
    const state = await withTimeout(sendMessage({ type: 'GPTLOCK_GET_STATE' }));
    const account = state?.account || { authenticated: false };
    renderAccount(account);
    return state;
  } catch (error) {
    // A page/runtime transport timeout is not an authentication failure. Keep a known
    // account snapshot visible instead of flashing "logged out" until the next heartbeat.
    showAppScreen();
    if (!cachedAccount && !accountAuthenticated) {
      if (el.accountEmail) el.accountEmail.textContent = '账户状态暂不可用';
      if (el.accountTier) el.accountTier.textContent = error.message;
    } else if (el.accountUsage) {
      el.accountUsage.title = `账户状态刷新暂时延迟：${error.message}`;
    }
    return null;
  }
}

el.showLogin?.addEventListener('click', () => showPanel('login'));
el.showRegister?.addEventListener('click', () => showPanel('register'));
el.showForgot?.addEventListener('click', () => showPanel('forgot'));

el.loginForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  setMessage('正在登录…');
  void finishLogin().catch((error) => {
    if (error.code === 'DEVICE_LIMIT' && Array.isArray(error.details?.devices)) {
      renderDeviceReplacement(error.details);
      showPanel('deviceReplace');
      setMessage('密码验证成功，但设备数量已达上限。请选择旧设备替换。', 'bad');
      return;
    }
    setMessage(`登录失败：${error.message}`, 'bad');
  });
});

el.deviceReplaceForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const selected = [...el.deviceReplaceList.querySelectorAll('input[type="checkbox"]:checked')].map((item) => Number(item.value));
  const required = Math.max(1, Number(deviceLimitDetails?.requiredReleaseCount || 1));
  if (selected.length < required) {
    setMessage(`请至少选择 ${required} 台旧设备。`, 'bad');
    return;
  }
  if (!confirm(`确认释放 ${selected.length} 台旧设备并在当前设备登录 GPTWork？`)) return;
  setMessage('正在释放旧设备并登录…');
  void finishLogin(selected).catch((error) => {
    if (error.code === 'DEVICE_LIMIT' && Array.isArray(error.details?.devices)) {
      renderDeviceReplacement(error.details);
      setMessage(`仍需释放至少 ${error.details.requiredReleaseCount || 1} 台设备。`, 'bad');
      return;
    }
    setMessage(`设备替换登录失败：${error.message}`, 'bad');
  });
});

el.cancelDeviceReplace?.addEventListener('click', () => {
  deviceLimitDetails = null;
  showPanel('login');
});

el.registerForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (el.registerPassword.value !== el.registerPassword2.value) {
    setMessage('两次输入的密码不一致。', 'bad');
    return;
  }
  verificationEmail = el.registerEmail.value.trim();
  setMessage('正在创建账号…');
  void sendMessage({ type: 'GPTLOCK_ACCOUNT_REGISTER', email: verificationEmail, password: el.registerPassword.value })
    .then((registration) => {
      el.registerPassword.value = '';
      el.registerPassword2.value = '';
      if (registration?.verificationRequired === false) {
        el.loginEmail.value = verificationEmail;
        showPanel('login');
        setMessage('注册成功，当前服务端未启用邮箱验证，请直接登录。', 'good');
        return;
      }
      el.verifyEmailText.textContent = `验证码已发送至 ${verificationEmail}`;
      showPanel('verify');
      setMessage('验证码已发送，请检查邮箱。', 'good');
    })
    .catch((error) => setMessage(`注册失败：${error.message}`, 'bad'));
});

el.verifyForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  setMessage('正在验证邮箱…');
  void sendMessage({ type: 'GPTLOCK_ACCOUNT_VERIFY_EMAIL', email: verificationEmail, code: el.verifyCode.value.trim() })
    .then(() => {
      el.verifyCode.value = '';
      el.loginEmail.value = verificationEmail;
      showPanel('login');
      setMessage('邮箱验证成功，请登录。', 'good');
    })
    .catch((error) => setMessage(`验证失败：${error.message}`, 'bad'));
});

el.resendVerification?.addEventListener('click', () => {
  if (!verificationEmail) return;
  setMessage('正在重新发送验证码…');
  void sendMessage({ type: 'GPTLOCK_ACCOUNT_RESEND_VERIFICATION', email: verificationEmail })
    .then(() => setMessage('如果邮箱仍待验证，新的验证码已发送。', 'good'))
    .catch((error) => setMessage(`发送失败：${error.message}`, 'bad'));
});

el.forgotForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  resetEmail = el.forgotEmail.value.trim();
  setMessage('正在请求重置验证码…');
  void sendMessage({ type: 'GPTLOCK_ACCOUNT_FORGOT_PASSWORD', email: resetEmail })
    .then(() => {
      el.resetEmailText.textContent = `如果 ${resetEmail} 已注册，验证码已经发送。`;
      showPanel('reset');
      setMessage('请检查邮箱中的重置验证码。', 'good');
    })
    .catch((error) => setMessage(`请求失败：${error.message}`, 'bad'));
});

el.resetForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  setMessage('正在重置密码…');
  void sendMessage({ type: 'GPTLOCK_ACCOUNT_RESET_PASSWORD', email: resetEmail, code: el.resetCode.value.trim(), newPassword: el.resetPassword.value })
    .then(() => {
      el.resetCode.value = '';
      el.resetPassword.value = '';
      el.loginEmail.value = resetEmail;
      showPanel('login');
      setMessage('密码已重置，请使用新密码登录。', 'good');
    })
    .catch((error) => setMessage(`重置失败：${error.message}`, 'bad'));
});

el.accountCenter?.addEventListener('click', () => {
  if (!accountAuthenticated) {
    showAuthScreen('请先登录或注册 GPTWork。');
    return;
  }
  void chrome.tabs.create({ url: chrome.runtime.getURL('account.html') });
});
el.accountUpgrade?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('account.html#upgrade') }));

el.accountLogout?.addEventListener('click', () => {
  void sendMessage({ type: 'GPTLOCK_ACCOUNT_LOGOUT' })
    .then(async () => {
      await refreshGate();
      window.dispatchEvent(new CustomEvent('gptlock-account-changed'));
    })
    .catch((error) => setMessage(`退出失败：${error.message}`, 'bad'));
});

window.addEventListener('gptlock-auth-required', (event) => {
  showAuthScreen(event.detail?.message || '请先登录或注册 GPTWork。');
});
window.addEventListener('gptlock-account-refresh', () => void refreshGate());

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[ACCOUNT_SNAPSHOT_KEY]) return;
  const account = changes[ACCOUNT_SNAPSHOT_KEY].newValue;
  renderAccount(account && typeof account === 'object' ? account : { authenticated: false });
});

void refreshGate();
