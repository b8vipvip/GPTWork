export const RUNTIME_GENERATION = '0.5.56-tab-isolation-r3';
export const RUNTIME_GENERATION_MESSAGE = 'GPTWORK_RUNTIME_GENERATION_GET';

function isServiceWorkerContext() {
  try {
    return typeof ServiceWorkerGlobalScope !== 'undefined'
      && globalThis instanceof ServiceWorkerGlobalScope;
  } catch {
    return false;
  }
}

// Runtime generation is a transport concern only. Register exactly one synchronous
// responder in the MV3 service worker; extension pages import this module for the
// constants but never become generation responders themselves.
if (isServiceWorkerContext()) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== RUNTIME_GENERATION_MESSAGE) return false;
    sendResponse({ ok: true, data: { generation: RUNTIME_GENERATION } });
    return false;
  });
}
