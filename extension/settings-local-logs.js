const exportButton = document.getElementById('exportLocalLogs');
const clearButton = document.getElementById('clearLocalLogs');
const openButton = document.getElementById('openLocalDiagnostics');
const count = document.getElementById('localLogCount');
const message = document.getElementById('localLogMessage');

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

function setMessage(text, bad = false) {
  if (!message) return;
  message.textContent = text || '';
  message.className = bad ? 'inline-message bad' : 'inline-message good';
}

async function readLogs() {
  const result = await sendMessage({ type: 'GPTLOCK_GET_RUNTIME_LOGS' });
  const logs = Array.isArray(result?.logs) ? result.logs : [];
  if (count) count.textContent = `${logs.length} / 2000`;
  return logs;
}

async function exportLogs() {
  exportButton.disabled = true;
  try {
    const logs = await readLogs();
    const header = {
      schemaVersion: 1,
      type: 'gptwork-local-runtime-log-export',
      exportedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version,
      entryCount: logs.length,
    };
    const lines = [header, ...logs].map((entry) => JSON.stringify(entry));
    const blob = new Blob([`${lines.join('\n')}\n`], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gptwork-local-runtime-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    setMessage(`已导出 ${logs.length} 条本地运行日志 / Exported ${logs.length} entries.`);
  } catch (error) {
    setMessage(`导出失败 / Export failed: ${error.message}`, true);
  } finally {
    exportButton.disabled = false;
  }
}

async function clearLogs() {
  if (!window.confirm('确认清空 GPTWork 本地运行日志？此操作不会修改账号、模型或功能设置。')) return;
  clearButton.disabled = true;
  try {
    await sendMessage({ type: 'GPTLOCK_CLEAR_RUNTIME_LOGS' });
    // The legacy background handler writes one bookkeeping event immediately after
    // clearing. The Settings "清空" action is user-facing, so finish by clearing the
    // local ring buffer directly and leave it truly empty.
    await chrome.storage.local.set({ runtimeLogs: [], runtimeLogUploadedIds: [] });
    if (count) count.textContent = '0 / 2000';
    setMessage('本地运行日志已清空 / Local runtime logs cleared.');
  } catch (error) {
    setMessage(`清空失败 / Clear failed: ${error.message}`, true);
  } finally {
    clearButton.disabled = false;
  }
}

exportButton?.addEventListener('click', () => void exportLogs());
clearButton?.addEventListener('click', () => void clearLogs());
openButton?.addEventListener('click', () => {
  void sendMessage({ type: 'GPTLOCK_OPEN_DIAGNOSTICS' }).catch((error) => setMessage(error.message, true));
});

void readLogs().catch((error) => setMessage(`读取本地日志失败：${error.message}`, true));
