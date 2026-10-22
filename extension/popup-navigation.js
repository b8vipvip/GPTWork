const checkUpdateButton = document.getElementById('checkUpdate');

checkUpdateButton?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  const url = chrome.runtime.getURL('update.html?check=1');
  void chrome.tabs.create({ url }).then(() => window.close());
}, { capture: true });

const debugToolsButton = document.getElementById('debugTools');
debugToolsButton?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  const url = chrome.runtime.getURL('debug-tools.html');
  void chrome.tabs.create({ url }).then(() => window.close());
}, { capture: true });
