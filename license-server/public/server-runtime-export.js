const limitSelect = document.getElementById('runtimeExportLimit');
const exportButton = document.getElementById('exportRuntimeScoped');
const message = document.getElementById('runtimeExportMessage');

function setMessage(text, tone = '') {
  if (!message) return;
  message.textContent = text || '';
  message.className = `message ${tone}`.trim();
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function saveText(text, filename) {
  const blob = new Blob([text], { type: 'application/x-ndjson;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

async function responseError(response) {
  const body = await response.json().catch(() => ({}));
  return new Error(body.error?.message || `HTTP ${response.status}`);
}

async function exportRecent() {
  if (!exportButton || !limitSelect) return;
  const selected = limitSelect.value;
  const label = selected === 'all' ? '全部保留日志' : `最近 ${selected} 行`;
  const original = exportButton.textContent;
  exportButton.disabled = true;
  exportButton.textContent = '导出中…';
  setMessage(`正在导出${label}…`);
  try {
    let text = '';
    let count = 0;
    if (selected === 'all') {
      const response = await fetch('/admin/api/runtime-logs/export', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw await responseError(response);
      text = await response.text();
      count = text.split(/\r?\n/).filter(Boolean).length;
    } else {
      const limit = Number(selected);
      if (![200, 500, 1000].includes(limit)) throw new Error('日志导出范围无效');
      const response = await fetch(`/admin/api/runtime-logs?limit=${limit}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw await responseError(response);
      const body = await response.json();
      const rows = Array.isArray(body.logs) ? body.logs.slice(-limit) : [];
      count = rows.length;
      text = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
    }
    const suffix = selected === 'all' ? 'all' : `recent-${selected}`;
    saveText(text, `gptlock-server-runtime-${suffix}-${stamp()}.jsonl`);
    setMessage(`已导出${label}，共 ${count} 行。`, 'good');
  } catch (error) {
    setMessage(`导出失败：${error.message}`, 'bad');
  } finally {
    exportButton.disabled = false;
    exportButton.textContent = original;
  }
}

exportButton?.addEventListener('click', () => void exportRecent());
