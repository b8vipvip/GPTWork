(() => {
  const masterToggle = document.querySelector('#enabled[data-gptwork-master-toggle="true"]');
  let explicitMasterIntentUntil = 0;

  if (masterToggle) {
    masterToggle.addEventListener('change', () => {
      explicitMasterIntentUntil = Date.now() + 1500;
    }, true);
  }

  try {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message?.type === 'GPTLOCK_SET_ENABLED') {
        const explicitMasterAction = Boolean(
          masterToggle
          && Date.now() <= explicitMasterIntentUntil
          && Boolean(message.enabled) === Boolean(masterToggle.checked),
        );
        if (!explicitMasterAction) {
          // Work mode and Model lock are subordinate feature gates. Legacy controllers
          // still ask to derive the master state from their OR value; convert that old
          // request into a harmless account/tab refresh so only the visible master
          // switch can start or stop GPTWork globally.
          return originalSendMessage({ type: 'GPTLOCK_ACCOUNT_REFRESH' }, ...args);
        }
      }
      return originalSendMessage(message, ...args);
    };
  } catch {
    // Background persistence remains authoritative if this compatibility patch cannot install.
  }
})();
