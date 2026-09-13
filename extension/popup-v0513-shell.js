const POPUP_RUNTIME_KEY = 'gptlockPopupRuntimeInfo';
const SHELL_REVISION = 'v0513-single-authority-1';

function openUpdateCenter(event) {
  event.preventDefault();
  event.stopPropagation();
  const settingsPage = chrome.runtime.getManifest().options_ui?.page || 'settings-v0521.html';
  const url = chrome.runtime.getURL(`${settingsPage}#updates-auto`);
  void chrome.tabs.create({ url }).then(() => window.close());
}

async function persistRuntimeFingerprint() {
  const payload = {
    schemaVersion: 2,
    extensionVersion: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    entrypoint: location.pathname.split('/').pop() || location.pathname,
    shellRevision: SHELL_REVISION,
    documentUrl: location.href,
    recordedAt: new Date().toISOString(),
  };
  try {
    await chrome.storage.local.set({ [POPUP_RUNTIME_KEY]: payload });
  } catch {
    // Diagnostics are best effort and must never prevent the popup from opening.
  }
}

void persistRuntimeFingerprint();

document.getElementById('checkUpdate')?.addEventListener('click', openUpdateCenter, true);
