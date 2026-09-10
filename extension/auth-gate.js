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

let verificationEmail = '';
let resetEmail = '';
let deviceLimitDetails = null;

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

function setMessage(text, tone = '') {
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
  for (const panel of Object.values(map)) panel.hidden = true;
  map[name].hidden = false;
  el.showLogin.classList.toggle('active', name === 'login');
  el.showRegister.classList.toggle('active', name === 'register' || name === 'verify');
  el.showForgot.classList.toggle('active', name === 'forgot' || name === 'reset');
  setMessage('');
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
  el.authShell.hidden = authenticated;
  el.appShell.hidden = !authenticated;
  if (!authenticated) return;

  const user = account.user || {};
  const entitlement = account.entitlement || {};
  const sourceName = account.level?.name || entitlement.level?.name || '普通用户';
  el.accountEmail.textContent = user.email || '—';
  el.accountTier.textContent = sourceName;
  el.accountExpiry.textContent = `有效期 ${localDate(entitlement.expiresAt)}`;
  const usage = entitlement.usage || {};
  const limits = entitlement.limits || {};
  el.accountUsage.textContent = `设备 ${usage.devices ?? 0}/${limits.devices ?? 0} · 窗口 ${usage.windows ?? 0}/${limits.windows ?? 0}`;
  if (el.enabled) {
    if (!entitlement.active) el.enabled.title = '当前使用时长已到期，请签到、分享或升级用户等级';
    else el.enabled.title = `启用或关闭 GPTWork；当前等级最多 ${limits.windows ?? 1} 个同时窗口`;
  }
  window.dispatchEvent(new CustomEvent('gptlock-entitlement-state', {
    detail: { authenticated, active: Boolean(entitlement.active) },
  }));
}

async function refreshGate() {
  try {
    const state = await sendMessage({ type: 'GPTLOCK_GET_STATE' });
    const account = state?.account || { authenticated: false };
    renderAccount(account);
    if (!account.authenticated) showPanel('login');
    return state;
  } catch (error) {
    el.authShell.hidden = false;
    el.appShell.hidden = true;
    showPanel('login');
    setMessage(`读取账户状态失败：${error.message}`, 'bad');
    return null;
  }
}

el.showLogin.addEventListener('click', () => showPanel('login'));
el.showRegister.addEventListener('click', () => showPanel('register'));
el.showForgot.addEventListener('click', () => showPanel('forgot'));

el.loginForm.addEventListener('submit', (event) => {
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

el.deviceReplaceForm.addEventListener('submit', (event) => {
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

el.cancelDeviceReplace.addEventListener('click', () => {
  deviceLimitDetails = null;
  showPanel('login');
});

el.registerForm.addEventListener('submit', (event) => {
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

el.verifyForm.addEventListener('submit', (event) => {
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

el.resendVerification.addEventListener('click', () => {
  if (!verificationEmail) return;
  setMessage('正在重新发送验证码…');
  void sendMessage({ type: 'GPTLOCK_ACCOUNT_RESEND_VERIFICATION', email: verificationEmail })
    .then(() => setMessage('如果邮箱仍待验证，新的验证码已发送。', 'good'))
    .catch((error) => setMessage(`发送失败：${error.message}`, 'bad'));
});

el.forgotForm.addEventListener('submit', (event) => {
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

el.resetForm.addEventListener('submit', (event) => {
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

el.accountCenter?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('account.html') }));
el.accountUpgrade?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('account.html#upgrade') }));

el.accountLogout.addEventListener('click', () => {
  void sendMessage({ type: 'GPTLOCK_ACCOUNT_LOGOUT' })
    .then(async () => {
      await refreshGate();
      window.dispatchEvent(new CustomEvent('gptlock-account-changed'));
    })
    .catch((error) => setMessage(`退出失败：${error.message}`, 'bad'));
});

window.addEventListener('gptlock-account-refresh', () => void refreshGate());
void refreshGate();