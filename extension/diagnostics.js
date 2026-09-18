const elements = {
  version: document.getElementById('version'),
  refresh: document.getElementById('refresh'),
  export: document.getElementById('export'),
  clear: document.getElementById('clear'),
  level: document.getElementById('level'),
  component: document.getElementById('component'),
  search: document.getElementById('search'),
  exportLimit: document.getElementById('exportLimit'),
  count: document.getElementById('count'),
  message: document.getElementById('message'),
  logs: document.getElementById('logs'),
};

let runtimeLogs = [];

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || 'Extension request failed'));
      else resolve(response.data);
    });
  });
}

function filteredLogs() {
  const level = elements.level.value;
  const component = elements.component.value;
  const query = elements.search.value.trim().toLowerCase();
  return runtimeLogs.filter((entry) => {
    if (level !== 'all' && entry.level !== level) return false;
    if (component !== 'all' && entry.component !== component) return false;
    if (!query) return true;
    return JSON.stringify(entry).toLowerCase().includes(query);
  });
}

function render() {
  const logs = filteredLogs().slice().reverse();
  elements.count.textContent = `${logs.length} / ${runtimeLogs.length} 条`;
  elements.logs.replaceChildren();
  if (!logs.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '暂无匹配日志 / No matching runtime logs.';
    elements.logs.append(empty);
    return;
  }

  for (const entry of logs) {
    const details = document.createElement('details');
    details.className = 'entry';
    details.dataset.level = entry.level;
    const summary = document.createElement('summary');
    const time = document.createElement('time');
    time.dateTime = entry.timestamp;
    time.textContent = new Date(entry.timestamp).toLocaleString();
    const level = document.createElement('span');
    level.className = 'level';
    level.textContent = entry.level;
    const component = document.createElement('span');
    component.className = 'component';
    component.textContent = entry.component;
    const event = document.createElement('span');
    event.className = 'event';
    event.textContent = entry.event;
    summary.append(time, level, component, event);
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(entry.details ?? {}, null, 2);
    details.append(summary, pre);
    elements.logs.append(details);
  }
}

function updateComponents() {
  const previous = elements.component.value;
  const values = [...new Set(runtimeLogs.map((entry) => entry.component).filter(Boolean))].sort();
  elements.component.replaceChildren();
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = '全部 / All';
  elements.component.append(all);
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    elements.component.append(option);
  }
  elements.component.value = values.includes(previous) ? previous : 'all';
}

async function load() {
  elements.refresh.disabled = true;
  const [state, result] = await Promise.all([
    sendMessage({ type: 'GPTLOCK_GET_STATE' }),
    sendMessage({ type: 'GPTLOCK_GET_RUNTIME_LOGS' }),
  ]);
  elements.version.textContent = state.extensionVersion || '';
  runtimeLogs = Array.isArray(result.logs) ? result.logs : [];
  updateComponents();
  render();
  elements.message.textContent = `已加载 ${runtimeLogs.length} 条运行日志 / Loaded ${runtimeLogs.length} runtime log entries.`;
  elements.refresh.disabled = false;
}

async function exportDiagnostics() {
  elements.export.disabled = true;
  elements.message.textContent = '正在收集扩展日志与本地核心审计记录 / Collecting extension and core diagnostics…';
  try {
    const entryLimit = Math.min(300, Math.max(1, Number(elements.exportLimit?.value || 300)));
    const bundle = await sendMessage({ type: 'GPTLOCK_EXPORT_DIAGNOSTICS', entryLimit });
    const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    link.download = `gptlock-diagnostics-${stamp}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    const stream = bundle.autoVerificationStream;
    const entries = Array.isArray(stream?.entries) ? stream.entries : [];
    const sseCount = entries.filter((entry) => entry.transport === 'sse').length;
    const wsCount = entries.filter((entry) => entry.transport === 'websocket').length;
    elements.message.textContent = entries.length
      ? `诊断包已导出；自动验证流共 ${entries.length} 条（SSE ${sseCount} / WebSocket ${wsCount}），${stream.includedBytes || 0} 字节${stream.overflowed ? '，另有超限数据未完整打包' : ''}。`
      : `诊断包已导出；最近 ${bundle.exportSelection?.recentEntries || entryLimit} 条范围内没有可打包的自动验证流数据 / Diagnostic bundle exported.`;
  } finally {
    elements.export.disabled = false;
  }
}

elements.refresh.addEventListener('click', () => {
  void load().catch((error) => { elements.message.textContent = error.message; });
});
elements.export.addEventListener('click', () => {
  void exportDiagnostics().catch((error) => { elements.message.textContent = `导出失败 / Export failed: ${error.message}`; });
});
elements.clear.addEventListener('click', () => {
  if (!window.confirm('确认清空扩展运行日志和自动验证流诊断缓存？本地核心 audit.jsonl 不会被删除。\nClear extension runtime logs and auto-verification stream cache? Native audit.jsonl will be kept.')) return;
  void sendMessage({ type: 'GPTLOCK_CLEAR_RUNTIME_LOGS' })
    .then(load)
    .catch((error) => { elements.message.textContent = error.message; });
});
for (const control of [elements.level, elements.component, elements.search]) {
  control.addEventListener(control === elements.search ? 'input' : 'change', render);
}

void load().catch((error) => {
  elements.message.textContent = `日志读取失败 / Failed to load logs: ${error.message}`;
  elements.refresh.disabled = false;
});
