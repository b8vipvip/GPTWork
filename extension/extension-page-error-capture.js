import { appendRuntimeLog } from './runtime-log.js';

const SENTINEL = '__GPTWORK_EXTENSION_PAGE_ERROR_CAPTURE_V1__';
if (!globalThis[SENTINEL]) {
  globalThis[SENTINEL] = true;
  const context = location.pathname.split('/').pop() || 'extension-page';
  const clip = (value, max = 2000) => {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…[truncated:${text.length}]` : text;
  };
  const record = (event, details = {}) => {
    void appendRuntimeLog('error', `extension-page:${context}`, event, details).catch(() => {});
  };

  window.addEventListener('error', (event) => {
    record('uncaught_error', {
      message: clip(event.message),
      filename: clip(event.filename, 500),
      line: Number(event.lineno || 0),
      column: Number(event.colno || 0),
      stack: clip(event.error?.stack || ''),
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    record('unhandled_rejection', {
      message: clip(reason?.message || reason),
      stack: clip(reason?.stack || ''),
    });
  });

  void appendRuntimeLog('info', `extension-page:${context}`, 'page_runtime_started', {
    extensionVersion: chrome.runtime.getManifest().version,
  }).catch(() => {});
}
