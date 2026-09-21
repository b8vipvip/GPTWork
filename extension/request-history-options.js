import { KNOWN_MODELS } from './policy.js';
import { buildRequestModelHistory, REQUEST_HISTORY_LIMIT } from './request-history.js';

const RUNTIME_LOG_STORAGE_KEY = 'runtimeLogs';
const REQUEST_HISTORY_ENABLED_KEY = 'gptworkRequestHistoryEnabled';
const PAGE_SIZE = 8;
const elements = {
  enabled: document.getElementById('requestHistoryEnabled'),
  body: document.getElementById('requestHistoryBody'),
  empty: document.getElementById('requestHistoryEmpty'),
  count: document.getElementById('requestHistoryCount'),
  pagination: document.getElementById('requestHistoryPagination'),
  prev: document.getElementById('requestHistoryPrev'),
  next: document.getElementById('requestHistoryNext'),
  pageInfo: document.getElementById('requestHistoryPageInfo'),
  tableWrap: document.querySelector('.request-history-card .request-history-table-wrap'),
};

const knownLabels = new Map(KNOWN_MODELS.map((item) => [item.id, item.label]));
let refreshTimer = null;
let historyDirty = false;
let currentPage = 1;
let currentRecords = [];
let historyEnabled = false;

function modelLabel(model) {
  if (!model) return '未确认 / Unknown';
  return knownLabels.get(model) || model;
}

function appendModelCell(row, model, pendingText = null, transportModel = null) {
  const cell = document.createElement('td');
  if (!model) {
    cell.className = 'request-model-muted';
    cell.textContent = pendingText || '—';
    row.append(cell);
    return;
  }
  const strong = document.createElement('strong');
  strong.textContent = modelLabel(model);
  cell.append(strong);
  if (transportModel) {
    const code = document.createElement('code');
    code.textContent = transportModel;
    cell.append(code);
  }
  row.append(cell);
}

function statusPresentation(record) {
  switch (record.status) {
    case 'verified':
      return ['已确认 / Verified', 'good'];
    case 'mismatch':
      return ['不匹配 / Mismatch', 'bad'];
    case 'fallback':
      return ['服务端回退 / Server fallback', 'warn'];
    case 'unverified':
      return ['未完全确认 / Unverified', 'warn'];
    case 'error':
      return ['确认失败 / Error', 'bad'];
    case 'request_only':
      return ['仅请求 / Request only', 'neutral'];
    case 'unconfirmed':
      return ['未取得响应确认 / Unconfirmed', 'warn'];
    default:
      return ['等待响应 / Waiting', 'running'];
  }
}

function formatTime(value) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(parsed));
}

function appendHistoryRow(record) {
  const row = document.createElement('tr');
  const time = document.createElement('td');
  time.className = 'request-history-time';
  time.textContent = formatTime(record.capturedAt);
  row.append(time);

  appendModelCell(row, record.discoveredModel, null, record.discoveredTransportModel);
  appendModelCell(row, record.requestModel, null, record.requestTransportModel);
  appendModelCell(
    row,
    record.finalModel,
    record.status === 'waiting' ? '等待响应 / Waiting' : '未确认 / Unknown',
  );

  const statusCell = document.createElement('td');
  const [label, tone] = statusPresentation(record);
  const badge = document.createElement('span');
  badge.className = `request-history-status ${tone}`;
  badge.textContent = label;
  statusCell.append(badge);
  row.append(statusCell);

  elements.body.append(row);
}

function renderCurrentPage() {
  if (!elements.body) return;

  const totalRecords = currentRecords.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);

  elements.body.replaceChildren();
  if (elements.count) elements.count.textContent = `最近 ${totalRecords} / ${REQUEST_HISTORY_LIMIT}`;
  if (elements.empty) elements.empty.hidden = totalRecords > 0;

  if (elements.pagination) elements.pagination.hidden = totalRecords <= PAGE_SIZE;
  if (elements.prev) elements.prev.disabled = currentPage <= 1;
  if (elements.next) elements.next.disabled = currentPage >= totalPages;
  if (elements.pageInfo) {
    elements.pageInfo.textContent = `第 ${currentPage} / ${totalPages} 页 · 每页 ${PAGE_SIZE} 条`;
  }

  if (totalRecords === 0) return;

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRecords = currentRecords.slice(start, start + PAGE_SIZE);
  for (const record of pageRecords) appendHistoryRow(record);
}

function renderHistory(logs) {
  currentRecords = buildRequestModelHistory(logs, { limit: REQUEST_HISTORY_LIMIT });
  renderCurrentPage();
}

async function refreshHistory() {
  if (!historyEnabled) return;
  const stored = await chrome.storage.local.get(RUNTIME_LOG_STORAGE_KEY);
  renderHistory(Array.isArray(stored[RUNTIME_LOG_STORAGE_KEY]) ? stored[RUNTIME_LOG_STORAGE_KEY] : []);
}

function scheduleRefresh() {
  if (!historyEnabled) return;
  historyDirty = true;
  // Runtime logs are a high-frequency diagnostic stream. Rebuilding a 100-row
  // projection for every storage write made the Settings tab amplify browser jank.
  // Refresh only at an explicit visibility/focus boundary.
  if (document.visibilityState !== 'visible') return;
}

elements.prev?.addEventListener('click', () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  renderCurrentPage();
});

elements.next?.addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(currentRecords.length / PAGE_SIZE));
  if (currentPage >= totalPages) return;
  currentPage += 1;
  renderCurrentPage();
});

function renderEnabledState() {
  if (elements.enabled) elements.enabled.checked = historyEnabled;
  if (elements.tableWrap) elements.tableWrap.hidden = !historyEnabled;
  if (!historyEnabled) {
    currentRecords = [];
    currentPage = 1;
    elements.body?.replaceChildren();
    if (elements.count) elements.count.textContent = '已关闭 / Off';
    if (elements.empty) {
      elements.empty.hidden = false;
      elements.empty.textContent = '请求记录默认关闭；开启后才读取本地日志并生成记录。';
    }
    if (elements.pagination) elements.pagination.hidden = true;
  } else if (elements.empty) {
    elements.empty.textContent = '暂无正式请求记录 / No formal request records yet.';
  }
}

async function setHistoryEnabled(enabled) {
  historyEnabled = enabled === true;
  await chrome.storage.local.set({ [REQUEST_HISTORY_ENABLED_KEY]: historyEnabled });
  renderEnabledState();
  if (historyEnabled) await refreshHistory();
}

elements.enabled?.addEventListener('change', () => {
  void setHistoryEnabled(elements.enabled.checked).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[REQUEST_HISTORY_ENABLED_KEY]) {
    historyEnabled = changes[REQUEST_HISTORY_ENABLED_KEY].newValue === true;
    renderEnabledState();
    if (historyEnabled) void refreshHistory().catch(() => {});
    return;
  }
  if (historyEnabled && changes[RUNTIME_LOG_STORAGE_KEY]) scheduleRefresh();
});

async function refreshIfDirty() {
  if (!historyEnabled || !historyDirty) return;
  historyDirty = false;
  await refreshHistory();
}
window.addEventListener('focus', () => void refreshIfDirty().catch(() => {}));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshIfDirty().catch(() => {});
});

void chrome.storage.local.get(REQUEST_HISTORY_ENABLED_KEY).then((stored) => {
  historyEnabled = stored[REQUEST_HISTORY_ENABLED_KEY] === true;
  renderEnabledState();
  if (historyEnabled) return refreshHistory();
  return null;
}).catch(() => {
  historyEnabled = false;
  renderEnabledState();
});
