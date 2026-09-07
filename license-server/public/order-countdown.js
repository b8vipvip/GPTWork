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

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startOrderCountdowns, { once: true });
else startOrderCountdowns();
