export const RUNTIME_GENERATION_KEY = 'gptworkRuntimeGeneration';
export const RUNTIME_GENERATION = '0.5.57-tab-isolation-r1';

export async function markRuntimeGeneration() {
  await chrome.storage.local.set({
    [RUNTIME_GENERATION_KEY]: RUNTIME_GENERATION,
  });
  return RUNTIME_GENERATION;
}
