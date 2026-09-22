const expected = new URLSearchParams(location.search).get('expected') || '';
(async () => {
  try {
    await chrome.storage.local.set({
      gptworkGenerationReload: {
        expected,
        manifestVersion: chrome.runtime.getManifest().version,
        requestedAt: new Date().toISOString(),
      },
    });
  } finally {
    setTimeout(() => chrome.runtime.reload(), 120);
  }
})();
