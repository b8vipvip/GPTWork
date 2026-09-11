import { appendRuntimeLog } from './runtime-log.js';

function clip(value, max = 2000) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…[truncated:${text.length}]` : text;
}

function record(event, details = {}) {
  void appendRuntimeLog('error', 'service-worker', event, details).catch(() => {});
}

globalThis.addEventListener?.('error', (event) => {
  record('uncaught_error', {
    message: clip(event?.message),
    filename: clip(event?.filename, 500),
    line: Number(event?.lineno || 0),
    column: Number(event?.colno || 0),
    stack: clip(event?.error?.stack || ''),
  });
});

globalThis.addEventListener?.('unhandledrejection', (event) => {
  const reason = event?.reason;
  record('unhandled_rejection', {
    message: clip(reason?.message || reason),
    stack: clip(reason?.stack || ''),
  });
});

void appendRuntimeLog('info', 'service-worker', 'error_capture_ready', {
  extensionVersion: chrome.runtime.getManifest().version,
}).catch(() => {});
