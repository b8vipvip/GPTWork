const orderCountdownState = {
  timer: null,
  observer: null,
  inflight: new Set(),
};

function orderIdFromRow(row) {
  const title = String(row?.querySelector('.list-main b')?.textContent || '');
  const match = title.match(/^#(\d+)/);
  return match ? match[1] : '';
}

async function fetchOrder(orderId) {
  const response = await fetch(`/site/api/account/orders/${encodeURIComponent(orderId)}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body?.error?.message || `请求失败 (${response.status})`);
  return body.order || null;
}

function remainingOrderText(expiresAt) {
  const remainingMs = Date.parse(expiresAt || '') - Date.now();
  if (!(remainingMs > 0)) return '已失效';
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `剩余 ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `剩余 ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function ensureCountdownNode(row) {
  const meta = row.querySelector('.list-main small');
  if (!meta) return null;
  let countdown = meta.querySelector('[data-order-expiry-countdown]');
  if (!countdown) {
    countdown = document.createElement('span');
    countdown.dataset.orderExpiryCountdown = '1';
    countdown.style.fontWeight = '800';
    countdown.style.marginLeft = '6px';
    meta.append(' · ', countdown);
  }
  return countdown;
}

function applyExpiredState(row) {
  const countdown = ensureCountdownNode(row);
  if (countdown) {
    countdown.textContent = '已失效';
    countdown.style.color = '#991b1b';
  }
  const action = row.querySelector('a');
  if (action && /继续/.test(action.textContent || '')) action.remove();
}

function updateRowCountdown(row) {
  const expiresAt = row.dataset.orderExpiresAt || '';
  if (!expiresAt) return;
  const countdown = ensureCountdownNode(row);
  if (!countdown) return;
  const text = remainingOrderText(expiresAt);
  countdown.textContent = text;
  countdown.style.color = text === '已失效' ? '#991b1b' : '#b45309';
  if (text !== '已失效') return;

  applyExpiredState(row);
  if (row.dataset.orderExpiryReconciled === '1') return;
  row.dataset.orderExpiryReconciled = '1';
  const orderId = orderIdFromRow(row);
  if (!orderId) return;
  void fetchOrder(orderId).then((order) => {
    if (order?.status === 'paid') location.reload();
  }).catch(() => {});
}

async function hydrateRow(row) {
  const orderId = orderIdFromRow(row);
  if (!orderId || row.dataset.orderExpiryLoaded === '1' || orderCountdownState.inflight.has(orderId)) return;
  const metaText = String(row.querySelector('.list-main small')?.textContent || '');
  if (!/^pending(?:\s|·|$)/i.test(metaText)) return;

  orderCountdownState.inflight.add(orderId);
  try {
    const order = await fetchOrder(orderId);
    row.dataset.orderExpiryLoaded = '1';
    if (!order) return;
    if (order.status !== 'pending') {
      if (order.status === 'expired') applyExpiredState(row);
      return;
    }
    const expiresAt = String(order.expiresAt || '');
    if (!Number.isFinite(Date.parse(expiresAt))) return;
    row.dataset.orderExpiresAt = expiresAt;
    updateRowCountdown(row);
  } catch {
    // The normal account refresh will retry. Countdown decoration must never break the account page.
  } finally {
    orderCountdownState.inflight.delete(orderId);
  }
}

function hydrateVisibleOrders() {
  document.querySelectorAll('#orderList .list-row').forEach((row) => void hydrateRow(row));
}

function tickOrderCountdowns() {
  document.querySelectorAll('#orderList .list-row[data-order-expires-at]').forEach(updateRowCountdown);
}

function startOrderCountdowns() {
  const list = document.getElementById('orderList');
  if (!list) return;
  hydrateVisibleOrders();
  orderCountdownState.observer = new MutationObserver(() => hydrateVisibleOrders());
  orderCountdownState.observer.observe(list, { childList: true, subtree: true });
  orderCountdownState.timer = setInterval(tickOrderCountdowns, 1000);
}

window.addEventListener('pagehide', () => {
  if (orderCountdownState.timer) clearInterval(orderCountdownState.timer);
  orderCountdownState.observer?.disconnect();
}, { once: true });

async function renderGuideStepsFromCms() {
  if (document.body.dataset.page !== 'guide') return;
  try {
    const response = await fetch('/site/api/website', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json().catch(() => null);
    const module = data?.config?.pages?.guide?.modules?.find((entry) => entry.id === 'guide-steps');
    if (!module?.enabled || !Array.isArray(module.items)) return;
    const steps = [...document.querySelectorAll('.guide-map .guide-step')];
    module.items.forEach((item, index) => {
      const step = steps[index];
      if (!step) return;
      const title = step.querySelector('h3');
      const body = step.querySelector('p');
      if (title) title.textContent = String(item?.title || '');
      if (body) body.textContent = String(item?.body || '');
    });
  } catch {
    // Static tutorial content remains usable if the CMS endpoint is temporarily unavailable.
  }
}

function isInstallerAssetLabel(label) {
  const name = String(label || '').split(' · ')[0].trim();
  return /(?:\.exe|\.msi|\.deb|\.rpm|\.dmg|\.pkg|\.appimage)$/i.test(name);
}

function filterReleaseAssetsToInstallers() {
  if (document.body.dataset.page !== 'releases') return;
  document.querySelectorAll('#releaseFeed .asset-link').forEach((link) => {
    if (!isInstallerAssetLabel(link.textContent)) link.remove();
  });
  document.querySelectorAll('#releaseFeed .asset-row').forEach((row) => {
    if (!row.querySelector('.asset-link')) row.remove();
  });
}

function startReleaseInstallerFilter() {
  if (document.body.dataset.page !== 'releases') return;
  const feed = document.getElementById('releaseFeed');
  if (!feed) return;
  filterReleaseAssetsToInstallers();
  const observer = new MutationObserver(filterReleaseAssetsToInstallers);
  observer.observe(feed, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
}

function ensureDisclaimerFooterLink() {
  const links = document.querySelector('.site-footer .footer-links');
  if (!links || links.querySelector('[data-disclaimer-link]')) return;
  const link = document.createElement('a');
  link.href = '/#disclaimer';
  link.textContent = '免责声明';
  link.dataset.disclaimerLink = '1';
  links.append(link);
}

function startSiteEnhancements() {
  startOrderCountdowns();
  void renderGuideStepsFromCms();
  startReleaseInstallerFilter();
  ensureDisclaimerFooterLink();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startSiteEnhancements, { once: true });
else startSiteEnhancements();
