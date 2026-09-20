const MODEL_VERIFICATION_HISTORY_KEY = 'modelVerificationHistoryV1';
const MAX_VISIBLE_RECORDS = 20;

const elements = {
  list: document.getElementById('modelVerificationHistoryList'),
  empty: document.getElementById('modelVerificationHistoryEmpty'),
  count: document.getElementById('modelVerificationHistoryCount'),
};

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { hour12: false })
    : '—';
}

function outcomeLabel(record) {
  if (record?.outcome === 'verified') return '全部通过';
  if (record?.outcome === 'partial') return '部分通过';
  return '未通过';
}

function modelTitle(item) {
  return item?.label || item?.model || item?.requestModel || '未知模型';
}

function renderModelResult(item) {
  const row = document.createElement('div');
  row.className = `model-verification-history-model ${item?.verified ? 'good' : 'bad'}`;
  const title = document.createElement('strong');
  title.textContent = `${item?.verified ? '✓' : '✕'} ${modelTitle(item)}`;
  const detail = document.createElement('span');
  const request = item?.requestModel || '—';
  const response = item?.responseModel || '未暴露';
  const reasoning = item?.responseReasoning || '未暴露';
  detail.textContent = item?.error
    ? `失败：${item.error}`
    : `请求确认 ${item?.requestConfirmed ? '是' : '否'} · 请求模型 ${request} · 响应确认 ${item?.responseConfirmed ? '是' : '否'} · 响应模型 ${response} · 推理 ${reasoning}`;
  row.append(title, detail);
  return row;
}

function renderHistory(records = []) {
  if (!elements.list || !elements.empty || !elements.count) return;
  const safe = Array.isArray(records) ? records.slice(0, MAX_VISIBLE_RECORDS) : [];
  elements.list.replaceChildren();
  elements.count.textContent = `最近 ${safe.length} 次`;
  elements.empty.hidden = safe.length > 0;

  for (const record of safe) {
    const item = document.createElement('article');
    item.className = 'model-verification-history-item';

    const head = document.createElement('div');
    head.className = 'model-verification-history-item-head';
    const title = document.createElement('strong');
    title.textContent = `${outcomeLabel(record)} · ${Number(record?.verified || 0)}/${Number(record?.total || 0)}`;
    const time = document.createElement('span');
    time.textContent = formatTime(record?.completedAt || record?.startedAt);
    head.append(title, time);

    const summary = document.createElement('p');
    summary.className = 'model-verification-history-summary';
    summary.textContent = record?.reason
      ? `结果：${record.reason}`
      : `验证成功 ${Number(record?.verified || 0)} · 未确认 ${Number(record?.failed || 0)}`;

    const models = document.createElement('div');
    models.className = 'model-verification-history-models';
    for (const result of Array.isArray(record?.results) ? record.results : []) {
      models.append(renderModelResult(result));
    }

    item.append(head, summary, models);
    elements.list.append(item);
  }
}

async function loadHistory() {
  const stored = await chrome.storage.local.get(MODEL_VERIFICATION_HISTORY_KEY);
  renderHistory(stored[MODEL_VERIFICATION_HISTORY_KEY]);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[MODEL_VERIFICATION_HISTORY_KEY]) return;
  renderHistory(changes[MODEL_VERIFICATION_HISTORY_KEY].newValue);
});

void loadHistory().catch(() => renderHistory([]));
