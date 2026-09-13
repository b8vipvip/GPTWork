import { RUNTIME_GENERATION, RUNTIME_GENERATION_MESSAGE } from './runtime-generation.js';

let generationReadyPromise = null;
let reloadRequested = false;

function never() {
  return new Promise(() => {});
}

function requestWorkerGeneration() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: RUNTIME_GENERATION_MESSAGE }, (response) => {
        const error = chrome.runtime.lastError;
        if (error || response?.ok !== true) {
          resolve(null);
          return;
        }
        resolve(response?.data?.generation ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

export function ensureRuntimeGeneration() {
  if (generationReadyPromise) return generationReadyPromise;
  generationReadyPromise = (async () => {
    // Ask the service worker that is actually handling messages which bundle generation
    // it is running. This is the sole update-skew decision: extension pages never infer
    // worker freshness from storage or from business-state responses.
    const workerGeneration = await requestWorkerGeneration();
    if (workerGeneration === RUNTIME_GENERATION) return true;

    // In-place installer updates can leave the previous MV3 worker alive while a newly
    // opened popup/settings page already executes the replacement files. Old workers
    // either report a different generation or reject this handshake as unsupported.
    // Reload exactly once, then stop this page generation permanently; no retry loop.
    if (!reloadRequested) {
      reloadRequested = true;
      try { chrome.runtime.reload(); } catch {}
    }
    return never();
  })();
  return generationReadyPromise;
}

export async function runtimeMessage(payload) {
  await ensureRuntimeGeneration();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      if (!response?.ok) {
        const requestError = new Error(response?.error || 'Extension request failed');
        requestError.code = response?.code || null;
        requestError.status = response?.status || null;
        requestError.details = response?.details || null;
        return reject(requestError);
      }
      resolve(response.data);
    });
  });
}

void ensureRuntimeGeneration();
