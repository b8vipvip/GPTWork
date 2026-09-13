import { RUNTIME_GENERATION, RUNTIME_GENERATION_KEY } from './runtime-generation.js';

let generationReadyPromise = null;
let reloadRequested = false;

function never() {
  return new Promise(() => {});
}

export function ensureRuntimeGeneration() {
  if (generationReadyPromise) return generationReadyPromise;
  generationReadyPromise = (async () => {
    const stored = await chrome.storage.local.get(RUNTIME_GENERATION_KEY);
    if (stored?.[RUNTIME_GENERATION_KEY] === RUNTIME_GENERATION) return true;

    // Installer updates replace the unpacked extension files in place. Chrome can keep
    // the previous MV3 service-worker generation alive while newly opened extension
    // pages already execute the new files. That produces protocol skew such as a new
    // popup sending GPTWORK_MASTER_SET to an old worker that reports it unsupported.
    // One centralized generation barrier reloads the extension before any feature or
    // Master controller is allowed to send runtime commands.
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
