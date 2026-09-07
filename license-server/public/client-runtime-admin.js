const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function setupClientRuntimeAdmin() {
  const elements = {
    app: $('app'),
    search: $('clientLogSearch'),
    level: $('clientLogLevel'),
    limit: $('clientLogLimit'),
    refresh: $('refreshClientLogs'),
    export: $('exportClientLogs'),
    clear: $('clearClientLogs'),
    summary: $('clientLogSummary'),
    body: $('clientLogsBody'),
  };
  if (!elements.app || !elements.search || !elements.level || !elements.limit || !elements.refresh || !elements.export || !elements.clear || !elements.summary || !elements.body) return;

  let currentRows = [];
  let currentTotal = 0;
  let retentionDays = 30;

  function queryString({ includeLimit = true } = {}) {
    const params = new URLSearchParams();
    const q = elements.search.value.trim();
    const level = elements.level.value;
    if (q) params.set('q', q);
    if (level) params.set('level', level);
    if (includeLimit) params.set('limit', elements.limit.value || '500');
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  function localDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function td(value, title = '') {
    const cell = document.createElement('td');
    cell.textContent = String(value ?? '');
    if (title) cell.title = title;
    return cell;
  }

  function detailsText(details) {
    try { return JSON.stringify(details ?? {}); }
    catch { return '[unserializable]'; }
  }

  function render() {
    elements.body.textContent = '';
    for (const row of currentRows) {
      const tr = document.createElement('tr');
      const detail = detailsText(row.details);
      const device = [row.deviceId || 'unknown', row.extensionVersion ? `v${row.extensionVersion}` : '', row.platform || ''].filter(Boolean).join(' · ');
      const detailCell = td(detail.length > 220 ? `${detail.slice(0, 220)}…` : detail, detail);
      detailCell.style.maxWidth = '520px';
      detailCell.style.whiteSpace = 'normal';
      detailCell.style.wordBreak = 'break-word';
      tr.append(
        td(localDate(row.timestamp)),
        td(`${row.email || '—'} (#${row.userId || '—'})`),
        td(device, `${row.deviceId || ''}\n${row.browserInstanceId || ''}`),
        td(String(row.level || 'info').toUpperCase()),
        td(row.component || 'extension'),
        td(row.event || 'unknown'),
        detailCell,
      );
      elements.body.append(tr);
    }
    if (!currentRows.length) {
      const tr = document.createElement('tr');
      const cell = td('暂无符合条件的客户端运行日志');
      cell.colSpan = 7;
      cell.className = 'empty';
      tr.append(cell);
      elements.body.append(tr);
    }
    elements.summary.textContent = `匹配 ${currentTotal} 条 · 当前显示 ${currentRows.length} 条 · 服务端保留 ${retentionDays} 天`;
  }

  async function load() {
    if (elements.app.hidden) return;
    elements.summary.textContent = '正在读取客户端运行日志…';
    try {
      const data = await api(`/admin/api/client-runtime-logs${queryString()}`);
      currentRows = Array.isArray(data.logs) ? data.logs : [];
      currentTotal = Number(data.total || 0);
      retentionDays = Number(data.retentionDays || 30);
      render();
    } catch (error) {
      if (error.status === 401) return;
      elements.summary.textContent = `客户端运行日志读取失败：${error.message}`;
    }
  }

  function exportCurrent() {
    const content = currentRows.map((row) => JSON.stringify(row)).join('\n');
    const blob = new Blob([content ? `${content}\n` : ''], { type: 'application/x-ndjson;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gptlock-client-runtime-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function clearFiltered() {
    const now = Date.now();
    if (Number(elements.clear.dataset.confirmUntil || 0) <= now) {
      elements.clear.dataset.confirmUntil = String(now + 5000);
      elements.clear.textContent = '再次点击确认清空';
      setTimeout(() => {
        if (Number(elements.clear.dataset.confirmUntil || 0) <= Date.now()) {
          elements.clear.dataset.confirmUntil = '0';
          elements.clear.textContent = '清空当前筛选';
        }
      }, 5100);
      return;
    }
    elements.clear.dataset.confirmUntil = '0';
    elements.clear.disabled = true;
    elements.clear.textContent = '清理中…';
    try {
      const data = await api(`/admin/api/client-runtime-logs${queryString({ includeLimit: false })}`, { method: 'DELETE' });
      elements.summary.textContent = `已删除 ${Number(data.deleted || 0)} 条客户端运行日志。`;
      await load();
    } catch (error) {
      elements.summary.textContent = `清理失败：${error.message}`;
    } finally {
      elements.clear.disabled = false;
      elements.clear.textContent = '清空当前筛选';
    }
  }

  elements.refresh.addEventListener('click', () => void load());
  elements.export.addEventListener('click', exportCurrent);
  elements.clear.addEventListener('click', () => void clearFiltered());
  elements.level.addEventListener('change', () => void load());
  elements.limit.addEventListener('change', () => void load());
  elements.search.addEventListener('keydown', (event) => { if (event.key === 'Enter') void load(); });

  const observer = new MutationObserver(() => { if (!elements.app.hidden) void load(); });
  observer.observe(elements.app, { attributes: true, attributeFilter: ['hidden'] });
  if (!elements.app.hidden) void load();
}

function setupServerRuntimeExport() {
  const limitSelect = $('runtimeExportLimit');
  const exportButton = $('exportRuntimeScoped');
  const message = $('runtimeExportMessage');
  if (!limitSelect || !exportButton) return;

  function setMessage(text, tone = '') {
    if (!message) return;
    message.textContent = text || '';
    message.className = `message ${tone}`.trim();
  }

  function saveText(text, filename) {
    const blob = new Blob([text], { type: 'application/x-ndjson;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function responseError(response) {
    const body = await response.json().catch(() => ({}));
    return new Error(body.error?.message || `HTTP ${response.status}`);
  }

  async function exportRecent() {
    const selected = limitSelect.value;
    const label = selected === 'all' ? '全部保留日志' : `最近 ${selected} 行`;
    const original = exportButton.textContent;
    exportButton.disabled = true;
    exportButton.textContent = '导出中…';
    setMessage(`正在导出${label}…`);
    try {
      let content = '';
      let count = 0;
      if (selected === 'all') {
        const response = await fetch('/admin/api/runtime-logs/export', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw await responseError(response);
        content = await response.text();
        count = content.split(/\r?\n/).filter(Boolean).length;
      } else {
        const limit = Number(selected);
        if (![200, 500, 1000].includes(limit)) throw new Error('日志导出范围无效');
        const data = await api(`/admin/api/runtime-logs?limit=${limit}`);
        const rows = Array.isArray(data.logs) ? data.logs.slice(-limit) : [];
        count = rows.length;
        content = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
      }
      const suffix = selected === 'all' ? 'all' : `recent-${selected}`;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      saveText(content, `gptlock-server-runtime-${suffix}-${stamp}.jsonl`);
      setMessage(`已导出${label}，共 ${count} 行。`, 'good');
    } catch (error) {
      setMessage(`导出失败：${error.message}`, 'bad');
    } finally {
      exportButton.disabled = false;
      exportButton.textContent = original;
    }
  }

  exportButton.addEventListener('click', () => void exportRecent());
}

setupClientRuntimeAdmin();
setupServerRuntimeExport();
