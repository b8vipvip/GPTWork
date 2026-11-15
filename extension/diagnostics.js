import { createModelEvidenceDiagnosticReport } from './model-evidence-diagnostic-report.js';

const elements = {
  status: document.getElementById('diagnosticStatus'),
  refresh: document.getElementById('refreshDiagnostics'),
  exportSummary: document.getElementById('exportSummary'),
  exportFull: document.getElementById('exportFull'),
  metricVersion: document.getElementById('metricVersion'),
  metricRuns: document.getElementById('metricRuns'),
  metricModels: document.getElementById('metricModels'),
  metricStreams: document.getElementById('metricStreams'),
  metricHistory: document.getElementById('metricHistory'),
  verificationTable: document.getElementById('verificationTable'),
  streamTable: document.getElementById('streamTable'),
};

let latestBundle = null;
let latestReport = null;
let latestHistory = [];
let historyEnabled = false;

function setStatus(message, bad = false) {
  if (!elements.status) return;
  elements.status.textContent = message || '';
  elements.status.style.color = bad ? '#dc2626' : '';
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || 'Extension request failed'));
      else resolve(response.data);
    });
  });
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { hour12: false }) : '—';
}

function makeCell(value, code = false) {
  const cell = document.createElement('td');
  const text = value === null || value === undefined || value === '' ? '—' : String(value);
  if (code) {
    const node = document.createElement('code');
    node.textContent = text;
    cell.append(node);
  } else {
    cell.textContent = text;
  }
  return cell;
}

function renderTable(container, headers, rows, emptyText) {
  container.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const header of headers) {
    const th = document.createElement('th');
    th.textContent = header;
    headerRow.append(th);
  }
  thead.append(headerRow);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const [value, code] of row) tr.append(makeCell(value, code));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  container.append(table);
}

function renderReport(report) {
  const runs = Array.isArray(report?.verificationRuns) ? report.verificationRuns : [];
  const models = runs.flatMap((run) => (Array.isArray(run.models) ? run.models : []).map((model) => ({ run, model })));
  const streams = Array.isArray(report?.streamCapture?.entries) ? report.streamCapture.entries : [];
  const history = report?.modelVerificationHistory || {};

  elements.metricVersion.textContent = report?.extension?.version || '—';
  elements.metricRuns.textContent = String(runs.length);
  elements.metricModels.textContent = String(models.length);
  elements.metricStreams.textContent = `${formatBytes(report?.streamCapture?.includedBytes)}${report?.streamCapture?.overflowed ? ' · 超限' : ''}`;
  elements.metricHistory.textContent = `${Number(history.recordCount || 0)}${history.enabled ? ' · 已开启' : ' · 未开启'}`;

  renderTable(
    elements.verificationTable,
    ['来源 Tab', '模型', 'Picker', 'Request ID', '请求模型', '响应模型', '响应确认', '未通过原因', '响应字段'],
    models.map(({ run, model }) => [
      [run.sourceTabId],
      [model.label || model.model],
      [model.pickerMode],
      [model.requestId, true],
      [model.rawRequestModel || model.requestModel],
      [model.rawResponseModel || model.responseModel],
      [model.responseConfirmed ? '是' : '否'],
      [model.responseIssue],
      [model.responseModelField],
    ]),
    '没有自动模型验证记录。请在 GPTWork 中运行一次模型验证后刷新。',
  );

  renderTable(
    elements.streamTable,
    ['Request ID', '传输', '阶段', '解析出的模型候选', '字段路径', '冲突', '大小', '验证权威'],
    streams.map((entry) => [
      [entry.requestId, true],
      [entry.transport],
      [entry.stage],
      [entry.parsedResponseCandidate?.rawModel || entry.parsedResponseCandidate?.model],
      [entry.parsedResponseCandidate?.field],
      [entry.parsedResponseCandidate?.conflict ? '是' : '否'],
      [formatBytes(entry.bodyBytes)],
      ['否（仅诊断）'],
    ]),
    '没有自动验证 SSE/WebSocket 捕获。缺少捕获不等于模型验证成功。',
  );
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function fileStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function loadDiagnostics() {
  elements.refresh.disabled = true;
  elements.exportSummary.disabled = true;
  elements.exportFull.disabled = true;
  setStatus('正在读取本地诊断信息… / Loading local diagnostics…');
  try {
    const [bundle, stored] = await Promise.all([
      sendMessage({ type: 'GPTLOCK_EXPORT_DIAGNOSTICS', entryLimit: 300 }),
      chrome.storage.local.get(['modelVerificationHistoryV1', 'gptworkModelVerificationHistoryEnabled']),
    ]);
    latestBundle = bundle || {};
    latestHistory = Array.isArray(stored.modelVerificationHistoryV1) ? stored.modelVerificationHistoryV1 : [];
    historyEnabled = stored.gptworkModelVerificationHistoryEnabled === true;
    latestReport = createModelEvidenceDiagnosticReport(latestBundle, {
      modelVerificationHistory: latestHistory,
      historyEnabled,
    });
    renderReport(latestReport);
    elements.exportSummary.disabled = false;
    elements.exportFull.disabled = false;
    const streamCount = latestReport.streamCapture.entries.length;
    const overflow = latestReport.streamCapture.overflowed ? '；捕获已达到大小上限' : '';
    setStatus(`诊断信息已更新：${latestReport.verificationRuns.length} 轮验证、${streamCount} 条流记录${overflow}。`);
  } catch (error) {
    setStatus(`读取诊断信息失败：${error.message}`, true);
  } finally {
    elements.refresh.disabled = false;
  }
}

elements.refresh?.addEventListener('click', () => void loadDiagnostics());
elements.exportSummary?.addEventListener('click', () => {
  if (!latestReport) return;
  downloadJson(`GPTWork-model-evidence-summary-${fileStamp()}.json`, latestReport);
  setStatus('已导出脱敏摘要；其中流解析结果仅为诊断候选。');
});
elements.exportFull?.addEventListener('click', () => {
  if (!latestBundle) return;
  const hasRawStream = (latestBundle.autoVerificationStream?.entries || []).length > 0;
  const warning = latestBundle.privacy?.noteZhCn
    || '完整诊断包可能包含自动验证流量中的短期 token、消息/会话 ID 和服务端元数据。';
  if (hasRawStream && !window.confirm(`完整诊断包包含原始自动验证 SSE/WebSocket 捕获。\n\n${warning}\n\n确认导出？`)) return;
  const full = {
    ...latestBundle,
    modelVerificationHistory: {
      enabled: historyEnabled,
      records: latestHistory,
    },
    modelEvidenceSummary: latestReport,
  };
  downloadJson(`GPTWork-full-diagnostics-${fileStamp()}.json`, full);
  setStatus('已导出完整诊断包。分享前请确认接收方可信。');
});

void loadDiagnostics();
