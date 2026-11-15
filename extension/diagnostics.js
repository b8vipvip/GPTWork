import {
  createDiagnosticsReport,
  DIAGNOSTICS_STORAGE_KEYS,
} from './diagnostics-evidence.js';

const $ = (id) => document.getElementById(id);
let currentReport = null;
let refreshing = false;

function call(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || '诊断数据读取失败'));
      else resolve(response.data);
    });
  });
}

function setStatus(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function addCell(row, value, secondary = '') {
  const cell = document.createElement('td');
  const main = document.createElement('span');
  main.textContent = value == null || value === '' ? '未暴露' : String(value);
  cell.append(main);
  if (secondary) {
    const note = document.createElement('small');
    note.className = 'muted';
    note.textContent = secondary;
    cell.append(note);
  }
  row.append(cell);
}

function yesNo(value) {
  return value === true ? '是' : value === false ? '否' : '未提供';
}

function time(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—';
}

function clearWithEmpty(root, colSpan, message) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = colSpan;
  cell.className = 'empty';
  cell.textContent = message;
  row.append(cell);
  root.replaceChildren(row);
}

function renderSummary(bundle, snapshot, stream) {
  $('version').textContent = bundle?.extension?.version || '—';
  $('platform').textContent = bundle?.extension?.platform || '平台未知';
  $('outcome').textContent = snapshot?.outcome || '暂无记录';
  $('verificationTime').textContent = snapshot ? time(snapshot.completedAt || snapshot.startedAt) : '暂无完成记录';
  $('verificationCount').textContent = snapshot
    ? `${snapshot.verified}/${snapshot.total} 通过 · ${snapshot.failed} 未通过`
    : '暂无数据';
  $('verificationReason').textContent = snapshot?.reason || (snapshot ? `请求确认 ${snapshot.requestConfirmed}` : '尚无可用证据');
  $('streamCount').textContent = stream.available ? `${stream.entries.length} 条` : '无捕获';
  $('streamBytes').textContent = stream.available
    ? `包含 ${stream.includedBytes} / ${stream.totalBytes} bytes · 溢出：${stream.overflowed ? '是' : '否'}`
    : '尚未捕获自动验证流';
}

function renderModels(snapshot) {
  const root = $('models');
  const results = Array.isArray(snapshot?.results) ? snapshot.results : [];
  if (!results.length) {
    clearWithEmpty(root, 8, '当前没有可展示的逐模型结果；检查模型历史是否启用，或是否有最近的自动验证运行。');
    return;
  }
  root.replaceChildren();
  for (const model of results) {
    const row = document.createElement('tr');
    const stage = model.selectorKey === '__picker_a_chat_lock__' || model.selectorKey === '__picker_b_chat_lock__'
      ? 'Chat Lock' : model.discoverySource || '';
    addCell(row, model.model, stage);
    addCell(row, model.pickerMode || '未记录',
      [model.selectionAttempted ? '已尝试选择' : '',
        model.selectionConfirmed == null ? '' : '选择 ' + yesNo(model.selectionConfirmed)].filter(Boolean).join(' · '));
    addCell(row, yesNo(model.requestConfirmed),
      [model.requestModel ? 'Model: ' + model.requestModel : '',
        model.rawRequestModel ? 'Raw: ' + model.rawRequestModel : '',
        model.networkObservedRequestModel ? 'Network: ' + model.networkObservedRequestModel : ''].filter(Boolean).join(' · '));
    addCell(row, yesNo(model.responseConfirmed),
      [model.responseModel ? 'Model: ' + model.responseModel : '',
        model.rawResponseModel ? 'Raw: ' + model.rawResponseModel : '',
        model.responseModelField ? 'Field: ' + model.responseModelField : '',
        model.responseHttpStatus == null ? '' : 'HTTP ' + model.responseHttpStatus].filter(Boolean).join(' · '));
    addCell(row, model.nativeStageComplete == null ? '未提供' : yesNo(model.nativeStageComplete),
      ['Request ' + yesNo(model.nativeRequestConfirmed),
        'Stream ' + yesNo(model.nativeResponseObserved),
        'Served ID ' + yesNo(model.nativeResponseConfirmed),
        model.nativeResponseModel ? model.nativeResponseModel : ''].filter(Boolean).join(' · '));
    addCell(row, model.chatLockStageComplete == null ? '未提供' : yesNo(model.chatLockStageComplete),
      ['Supported ' + yesNo(model.chatLockSupported),
        'Request ' + yesNo(model.chatLockRequestConfirmed),
        'Response ' + yesNo(model.chatLockResponseConfirmed)].join(' · '));
    addCell(row, model.responseIssue || model.nativeRequestIssue || model.nativeTransportFailure || model.error || '—',
      model.responseVerdict || model.evidenceSource || '');
    addCell(row, model.requestId || '未暴露',
      [model.responseRequestId ? 'Response ID: ' + model.responseRequestId : '',
        model.transportResponseRequestId ? 'Transport ID: ' + model.transportResponseRequestId : '',
        model.chatAttemptRequestId ? 'Chat ID: ' + model.chatAttemptRequestId : '',
        model.chatAttemptResponseRequestId ? 'Chat Response ID: ' + model.chatAttemptResponseRequestId : ''].filter(Boolean).join(' · '));
    root.append(row);
  }
}

function renderGatePublication(gate) {
  const root = $('gatePublication');
  if (!gate) {
    root.textContent = '当前运行日志中没有 shared_model_catalog_published 记录；四门资格数量保持未知，不从逐模型请求/响应结果推算。';
    root.classList.add('warning');
    return;
  }
  root.classList.remove('warning');
  const publishedAt = document.createElement('time');
  publishedAt.dateTime = gate.timestamp;
  publishedAt.textContent = '最近一次共享目录发布 · ' + time(gate.timestamp);
  publishedAt.style.gridColumn = '1 / -1';
  root.replaceChildren(publishedAt);
  const metrics = [
    ['提交模型', gate.submitted],
    ['Native 响应身份确认', gate.nativeResponseConfirmed],
    ['Work 流完成观察', gate.workNativeResponseObserved],
    ['Work 响应模型确认', gate.workNativeResponseMetadataConfirmed],
    ['Chat Lock 支持', gate.chatLockSupported],
    ['四门可发布', gate.fourGateEligible],
    ['共享目录数量', gate.shared],
  ];
  for (const [label, value] of metrics) {
    const item = document.createElement('div');
    item.className = 'gate-metric';
    const name = document.createElement('span');
    name.textContent = label;
    const number = document.createElement('strong');
    number.textContent = value == null ? '未提供' : String(value);
    item.append(name, number);
    root.append(item);
  }
}

function renderLogs(logs) {
  const root = $('logs');
  const relevant = (Array.isArray(logs) ? logs : []).filter((entry) =>
    entry?.component === 'discovery'
    || /model|verification|response/i.test(String(entry?.component || '')))
    .slice(-40).reverse();
  $('logCount').textContent = relevant.length + ' 条相关事件';
  if (!relevant.length) {
    clearWithEmpty(root, 5, '暂无相关运行时事件。');
    return;
  }
  root.replaceChildren();
  for (const entry of relevant) {
    const row = document.createElement('tr');
    const details = entry?.details && typeof entry.details === 'object' ? entry.details : {};
    const summary = [
      details.outcome ? '结果 ' + details.outcome : '',
      details.reason ? '原因 ' + details.reason : '',
      details.requestId ? 'Request ' + details.requestId : '',
      details.responseModel ? 'Response ' + details.responseModel : '',
      Number.isFinite(Number(details.catalogVerified)) ? '通过 ' + details.catalogVerified + '/' + (details.catalogTotal ?? '—') : '',
    ].filter(Boolean).join(' · ');
    addCell(row, time(entry.timestamp));
    addCell(row, entry.level || '—');
    addCell(row, entry.component || '—');
    addCell(row, entry.event || '—');
    addCell(row, summary || '—');
    root.append(row);
  }
}

function renderStreams(stream) {
  const root = $('streams');
  $('streamState').textContent = stream.available
    ? (stream.overflowed ? '捕获有溢出' : '已捕获元数据')
    : '未捕获';
  $('streamNotice').textContent = stream.available
    ? `捕获范围：${stream.captureScope || '未知'} · ${stream.entries.length} 条元数据 · 遗漏 ${stream.omittedResponses} 条。原始流内容不会显示或导出。`
    : '尚无自动验证流捕获。';
  $('streamNotice').classList.toggle('warning', stream.overflowed === true);
  if (!stream.entries.length) {
    clearWithEmpty(root, 7, stream.available ? '捕获已创建，但没有保留可展示的流条目。' : '暂无流捕获条目。');
    return;
  }
  root.replaceChildren();
  for (const entry of stream.entries.slice().reverse()) {
    const row = document.createElement('tr');
    addCell(row, time(entry.capturedAt));
    addCell(row, entry.requestId || '未暴露');
    addCell(row, entry.transport || entry.mimeType || '未知');
    addCell(row, entry.direction || '—', entry.stage || '');
    addCell(row, entry.httpStatus == null ? '未暴露' : entry.httpStatus);
    addCell(row, entry.requestModel || '未暴露');
    addCell(row, entry.bodyBytes);
    root.append(row);
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  $('refresh').disabled = true;
  $('export').disabled = true;
  setStatus('正在读取运行时日志、模型历史和自动验证流元数据…');
  try {
    const [bundleResult, logsResult, storageResult] = await Promise.allSettled([
      call('GPTLOCK_EXPORT_DIAGNOSTICS', { entryLimit: 300 }),
      call('GPTLOCK_GET_RUNTIME_LOGS'),
      chrome.storage.local.get([
        DIAGNOSTICS_STORAGE_KEYS.history,
        DIAGNOSTICS_STORAGE_KEYS.historyEnabled,
        DIAGNOSTICS_STORAGE_KEYS.streamCapture,
      ]),
    ]);
    const bundle = bundleResult.status === 'fulfilled' ? bundleResult.value : {};
    const logs = logsResult.status === 'fulfilled'
      ? logsResult.value?.logs || bundle.runtimeLogs || [] : bundle.runtimeLogs || [];
    const stored = storageResult.status === 'fulfilled' ? storageResult.value : {};
    const historyEnabled = stored[DIAGNOSTICS_STORAGE_KEYS.historyEnabled] === true;
    const history = Array.isArray(stored[DIAGNOSTICS_STORAGE_KEYS.history])
      ? stored[DIAGNOSTICS_STORAGE_KEYS.history] : [];
    const streamCapture = stored[DIAGNOSTICS_STORAGE_KEYS.streamCapture]
      || bundle.autoVerificationStream || null;
    currentReport = createDiagnosticsReport({ bundle, runtimeLogs: logs, history, historyEnabled, streamCapture });
    const snapshot = currentReport.modelVerification.latest;
    const stream = currentReport.streamCapture;
    renderSummary(bundle, snapshot, stream);
    renderModels(snapshot);
    renderGatePublication(currentReport.fourGatePublication);
    renderLogs(logs);
    renderStreams(stream);
    $('historyState').textContent = historyEnabled ? '已启用 · ' + history.length + ' 条' : '已关闭';
    $('historyNotice').textContent = historyEnabled
      ? `已读取 ${history.length} 条模型验证历史。当前结果来源：${snapshot?.source || '暂无'}。`
      : '模型验证历史持久化当前处于关闭状态；本页不会自动开启。仍可查看当前标签页诊断状态、运行时日志和流捕获元数据。';
    $('historyNotice').classList.toggle('warning', !historyEnabled);
    $('export').disabled = false;
    setStatus(bundleResult.status === 'rejected'
      ? '已读取本地运行日志与存储数据；完整诊断包不可用：' + bundleResult.reason.message
      : '诊断数据已刷新。原始流正文已从页面视图和摘要导出中排除。');
  } catch (error) {
    setStatus('读取诊断数据失败：' + String(error?.message || error), true);
  } finally {
    refreshing = false;
    $('refresh').disabled = false;
  }
}

$('refresh').addEventListener('click', () => void refresh());
$('export').addEventListener('click', () => {
  if (!currentReport) return;
  const blob = new Blob([JSON.stringify(currentReport, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'gptwork-diagnostics-summary-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[DIAGNOSTICS_STORAGE_KEYS.history]
    || changes[DIAGNOSTICS_STORAGE_KEYS.streamCapture]
    || changes[DIAGNOSTICS_STORAGE_KEYS.historyEnabled]) {
    void refresh();
  }
});

void refresh();
