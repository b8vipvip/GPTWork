import { KNOWN_MODELS } from './policy.js';
import { buildRequestModelHistory, REQUEST_HISTORY_LIMIT } from './request-history.js';

const RUNTIME_LOG_STORAGE_KEY = 'runtimeLogs';
const elements = {
  body: document.getElementById('requestHistoryBody'),
  empty: document.getElementById('requestHistoryEmpty'),
  count: document.getElementById('requestHistoryCount'),
};

const knownLabels = new Map(KNOWN_MODELS.map((item) => [item.id, item.label]));
let refreshTimer = null;

function modelLabel(model) {
  if (!model) return '未确认 / Unknown';
  return knownLabels.get(model) || model;
}

function appendModelCell(row, model, pendingText = null) {
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
  row.append(cell);
}

function statusPresentation(record) {
  switch (record.status) {
    case 'verified':
      return ['已确认 / Verified', 'good'];
    case 'mismatch':
      return ['不匹配 / Mismatch', 'bad'];
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

function renderHistory(logs) {
  if (!elements.body) return;
  const records = buildRequestModelHistory(logs, { limit: REQUEST_HISTORY_LIMIT });
  elements.body.replaceChildren();
  if (elements.count) elements.count.textContent = `最近 ${records.length} / ${REQUEST_HISTORY_LIMIT}`;
  if (elements.empty) elements.empty.hidden = records.length > 0;

  for (const record of records) {
    const row = document.createElement('tr');
    const time = document.createElement('td');
    time.className = 'request-history-time';
    time.textContent = formatTime(record.capturedAt);
    row.append(time);

    appendModelCell(row, record.discoveredModel);
    appendModelCell(row, record.requestModel);
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
}

async function refreshHistory() {
  const stored = await chrome.storage.local.get(RUNTIME_LOG_STORAGE_KEY);
  renderHistory(Array.isArray(stored[RUNTIME_LOG_STORAGE_KEY]) ? stored[RUNTIME_LOG_STORAGE_KEY] : []);
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refreshHistory().catch(() => {}), 80);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[RUNTIME_LOG_STORAGE_KEY]) return;
  scheduleRefresh();
});

void refreshHistory().catch(() => {
  if (elements.empty) {
    elements.empty.hidden = false;
    elements.empty.textContent = '请求记录读取失败 / Failed to load request history.';
  }
});
