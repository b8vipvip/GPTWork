const rewardSection = document.getElementById('rewardSection');
const guestNotice = document.getElementById('inviteGuestNotice');
const checkinButton = document.getElementById('dailyCheckin');
const checkinState = document.getElementById('checkinState');
const rewardExpiry = document.getElementById('rewardExpiry');
const inviteCode = document.getElementById('inviteCode');
const inviteLink = document.getElementById('inviteLink');
const inviteCount = document.getElementById('inviteCount');
const copyInvite = document.getElementById('copyInvite');
const rewardNotice = document.getElementById('rewardNotice');
const params = new URLSearchParams(location.search);
const pendingInviteCode = String(params.get('invite') || '').trim().toUpperCase();
let authenticated = false;
let inviteHandled = false;

function dateText(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function setNotice(message, tone = '') {
  if (!rewardNotice) return;
  rewardNotice.textContent = message || '';
  rewardNotice.className = `notice${tone ? ` ${tone}` : ''}${message ? '' : ' hidden'}`;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = data?.error?.code || '';
    throw error;
  }
  return data;
}

function render(rewards) {
  if (!rewards) return;
  rewardSection?.classList.remove('hidden');
  guestNotice?.classList.add('hidden');
  const checkin = rewards.checkin || {};
  const invite = rewards.invite || {};
  if (checkinState) checkinState.textContent = checkin.checkedInToday
    ? `今日已签到 · 累计 ${Number(checkin.totalCheckins || 0)} 天`
    : `今日可签到 · 每次 +${Number(checkin.rewardDays || 1)} 天`;
  if (checkinButton) {
    checkinButton.disabled = Boolean(checkin.checkedInToday);
    checkinButton.textContent = checkin.checkedInToday ? '今日已签到' : `签到 +${Number(checkin.rewardDays || 1)}`;
  }
  if (rewardExpiry) rewardExpiry.textContent = dateText(rewards.bonusExpiresAt);
  if (inviteCode) inviteCode.textContent = invite.code || '—';
  if (inviteLink) {
    inviteLink.value = invite.url || '';
    inviteLink.title = invite.url || '';
  }
  if (inviteCount) inviteCount.textContent = `${Number(invite.successfulInvites || 0)} 人 · 每人 +${Number(invite.rewardDays || 7)} 天`;
  if (copyInvite) {
    copyInvite.disabled = !invite.url;
    copyInvite.textContent = `分享 +${Number(invite.rewardDays || 7)}`;
  }
}

async function refresh() {
  try {
    const data = await request('/site/api/account/rewards');
    authenticated = true;
    render(data.rewards);
    return true;
  } catch (error) {
    authenticated = false;
    rewardSection?.classList.add('hidden');
    if (checkinButton) checkinButton.disabled = true;
    if (copyInvite) copyInvite.disabled = true;
    if (pendingInviteCode && error.status === 401) guestNotice?.classList.remove('hidden');
    return false;
  }
}

async function redeemPendingInvite() {
  if (!pendingInviteCode || inviteHandled || !authenticated) return;
  inviteHandled = true;
  try {
    const data = await request('/site/api/account/invite/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: pendingInviteCode }),
    });
    setNotice(data.alreadyRedeemed ? '该分享关系此前已经确认，无需重复操作。' : '分享关系已确认，分享人已获得 7 天使用时长。', 'good');
    history.replaceState(null, '', location.pathname);
    await refresh();
    document.dispatchEvent(new CustomEvent('gptwork-account-refresh'));
  } catch (error) {
    setNotice(`分享码处理失败：${error.message}`, 'error');
    if (error.status !== 401) history.replaceState(null, '', location.pathname);
    if (error.status === 401) inviteHandled = false;
  }
}

checkinButton?.addEventListener('click', async () => {
  checkinButton.disabled = true;
  setNotice('正在签到…');
  try {
    const data = await request('/site/api/account/checkin', { method: 'POST', body: '{}' });
    render(data.rewards);
    setNotice(data.alreadyCheckedIn ? '今天已经签到过了。' : '签到成功，权益有效期已增加 1 天。', 'good');
    document.dispatchEvent(new CustomEvent('gptwork-account-refresh'));
  } catch (error) {
    checkinButton.disabled = false;
    setNotice(`签到失败：${error.message}`, 'error');
  }
});

copyInvite?.addEventListener('click', async () => {
  const value = inviteLink?.value || '';
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    setNotice('分享链接已复制。对方注册并登录该链接后，你将获得 7 天使用时长。', 'good');
  } catch {
    inviteLink?.focus();
    inviteLink?.select();
    setNotice('请复制已选中的分享链接。');
  }
});

void (async () => {
  await refresh();
  await redeemPendingInvite();
  const timer = setInterval(async () => {
    if (document.hidden) return;
    await refresh();
    await redeemPendingInvite();
  }, 2500);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
})();
