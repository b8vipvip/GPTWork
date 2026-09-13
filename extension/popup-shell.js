function openUpdateCenter(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const url = chrome.runtime.getURL('options.html#updates-auto');
  void chrome.tabs.create({ url }).then(() => window.close());
}

const checkUpdate = document.getElementById('checkUpdate');
checkUpdate?.addEventListener('click', openUpdateCenter, true);
