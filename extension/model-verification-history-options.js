const MODEL_VERIFICATION_HISTORY_KEY = 'modelVerificationHistoryV1';
const PAGE_SIZE = 8;

const elements = {
  list: document.getElementById('modelVerificationHistoryList'),
  empty: document.getElementById('modelVerificationHistoryEmpty'),
  count: document.getElementById('modelVerificationHistoryCount'),
  clear: document.getElementById('modelVerificationHistoryClear'),
  pagination: document.getElementById('modelVerificationHistoryPagination'),
  prev: document.getElementById('modelVerificationHistoryPrev'),
  next: document.getElementById('modelVerificationHistoryNext'),
  pageInfo: document.getElementById('modelVerificationHistoryPageInfo'),
};
let currentPage = 1;
let currentRecords = [];

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—';
}
function outcomeLabel(record) {
  if (record?.outcome === 'verified') return '全部通过';
  if (record?.outcome === 'partial') return '部分通过';
  return '未通过';
}
function modelTitle(item) { return item?.label || item?.model || item?.requestModel || '未知模型'; }
function renderModelResult(item) {
  const row = document.createElement('div');
  row.className = `model-verification-history-model ${item?.verified ? 'good' : 'bad'}`;
  const title = document.createElement('strong');
  title.textContent = `${item?.verified ? '✓' : '✕'} ${modelTitle(item)}`;
  const detail = document.createElement('span');
  detail.textContent = item?.error
    ? `失败：${item.error}`
    : `选择器 ${item?.pickerMode || '—'} · 请求确认 ${item?.requestConfirmed ? '是' : '否'} · 请求模型 ${item?.requestModel || '—'} · 响应确认 ${item?.responseConfirmed ? '是' : '否'} · 响应模型 ${item?.responseModel || '未暴露'} · 推理 ${item?.responseReasoning || '未暴露'}`;
  row.append(title, detail);
  return row;
}
function downloadReport(record) {
  const report = record?.report || {
    schemaVersion: 1, generatedAt: record?.completedAt || new Date().toISOString(),
    type: 'gptwork-model-verification-report', verification: record,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = String(record?.completedAt || record?.startedAt || '').replace(/[:.]/g, '-');
  a.href = url; a.download = `GPTWork-model-verification-${stamp || 'report'}.json`; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderHistory(records = []) {
  if (!elements.list || !elements.empty || !elements.count) return;
  currentRecords = Array.isArray(records) ? records : [];
  const pageCount = Math.max(1, Math.ceil(currentRecords.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const safe = currentRecords.slice(start, start + PAGE_SIZE);
  elements.list.replaceChildren();
  elements.count.textContent = `共 ${currentRecords.length} 次`;
  elements.empty.hidden = currentRecords.length > 0;
  if (elements.pagination) elements.pagination.hidden = currentRecords.length <= PAGE_SIZE;
  if (elements.pageInfo) elements.pageInfo.textContent = `第 ${currentPage} / ${pageCount} 页`;
  if (elements.prev) elements.prev.disabled = currentPage <= 1;
  if (elements.next) elements.next.disabled = currentPage >= pageCount;
  for (const record of safe) {
    const item = document.createElement('article'); item.className = 'model-verification-history-item';
    const head = document.createElement('div'); head.className = 'model-verification-history-item-head';
    const title = document.createElement('strong');
    title.textContent = `${outcomeLabel(record)} · ${Number(record?.verified || 0)}/${Number(record?.total || 0)}`;
    const actions = document.createElement('div'); actions.className = 'model-verification-history-actions';
    const time = document.createElement('span'); time.textContent = formatTime(record?.completedAt || record?.startedAt);
    const exportButton = document.createElement('button'); exportButton.type = 'button'; exportButton.className = 'secondary model-verification-export';
    exportButton.textContent = '导出报告'; exportButton.addEventListener('click', () => downloadReport(record));
    actions.append(time, exportButton); head.append(title, actions);
    const summary = document.createElement('p'); summary.className = 'model-verification-history-summary';
    const context = record?.pageContext === 'existing_chat' ? '旧聊天' : record?.pageContext === 'new_chat' ? '新聊天' : '未知页面';
    const pickerModes = Array.isArray(record?.pickerModes) && record.pickerModes.length ? ` · 选择器 ${record.pickerModes.join('→')}` : '';
    summary.textContent = record?.reason ? `${context}${pickerModes} · 结果：${record.reason}` : `${context}${pickerModes} · 验证成功 ${Number(record?.verified || 0)} · 未确认 ${Number(record?.failed || 0)}`;
    const models = document.createElement('div'); models.className = 'model-verification-history-models';
    for (const result of Array.isArray(record?.results) ? record.results : []) models.append(renderModelResult(result));
    item.append(head, summary, models); elements.list.append(item);
  }
}
async function loadHistory() {
  const stored = await chrome.storage.local.get(MODEL_VERIFICATION_HISTORY_KEY);
  renderHistory(stored[MODEL_VERIFICATION_HISTORY_KEY]);
}
elements.clear?.addEventListener('click', async () => {
  if (!window.confirm('确定清空全部模型验证记录？')) return;
  await chrome.storage.local.remove(MODEL_VERIFICATION_HISTORY_KEY); currentPage = 1; renderHistory([]);
});
elements.prev?.addEventListener('click', () => { currentPage -= 1; renderHistory(currentRecords); });
elements.next?.addEventListener('click', () => { currentPage += 1; renderHistory(currentRecords); });
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[MODEL_VERIFICATION_HISTORY_KEY]) return;
  currentPage = 1; renderHistory(changes[MODEL_VERIFICATION_HISTORY_KEY].newValue);
});
void loadHistory().catch(() => renderHistory([]));
