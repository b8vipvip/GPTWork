const API_BASE = 'https://gptlock.mv3.cn';
const SESSION_KEY = 'gptlockAccountSessionToken';
const checkin = document.getElementById('accountCheckin');
const share = document.getElementById('accountShare');

async function token() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  return typeof stored[SESSION_KEY] === 'string' ? stored[SESSION_KEY] : '';
}
async function request(path, options = {}) {
  const session = await token();
  if (!session) throw new Error('请先登录');
  const response = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store', credentials: 'omit', ...options,
    headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error?.message || `HTTP ${response.status}`);
  return data;
}
function apply(rewards) {
  if (!checkin) return;
  const done = Boolean(rewards?.checkin?.checkedInToday);
  checkin.disabled = done;
  checkin.firstChild && (checkin.firstChild.textContent = done ? '已签到' : '签到');
  checkin.title = done ? '今天已签到，明天可再次领取 +1 天' : '每日签到增加 1 天使用时长';
  if (share) share.title = '复制分享链接；成功分享并带来 1 个已验证账户后增加 7 天使用时长';
}
async function refresh() {
  try { apply((await request('/api/v1/account/rewards')).rewards); } catch {}
}
checkin?.addEventListener('click', async () => {
  checkin.disabled = true;
  try {
    const data = await request('/api/v1/account/checkin', { method: 'POST', body: '{}' });
    apply(data.rewards);
    chrome.runtime.sendMessage({ type: 'GPTLOCK_ACCOUNT_REFRESH' }, () => void chrome.runtime.lastError);
    document.dispatchEvent(new CustomEvent('gptwork-account-changed'));
  } catch (error) {
    checkin.disabled = false;
    checkin.title = `签到失败：${error.message}`;
  }
});
share?.addEventListener('click', async () => {
  const original = share.firstChild?.textContent || '分享';
  try {
    const rewards = (await request('/api/v1/account/rewards')).rewards;
    const url = rewards?.share?.url || '';
    if (!url) throw new Error('分享链接暂不可用');
    await navigator.clipboard.writeText(url);
    if (share.firstChild) share.firstChild.textContent = '已复制';
    share.title = '分享链接已复制；对方完成注册/验证后，你将获得 +7 天';
    setTimeout(() => { if (share.firstChild) share.firstChild.textContent = original; }, 1200);
  } catch (error) { share.title = `分享失败：${error.message}`; }
});
window.addEventListener('gptlock-account-changed', () => void refresh());
document.addEventListener('gptwork-account-changed', () => void refresh());
void refresh();
