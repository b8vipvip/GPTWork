const POPUP_RUNTIME_KEY = 'gptlockPopupRuntimeInfo';
const SHELL_REVISION = 'v0513-license-ui-purge-1';

const LEGACY_LICENSE_SELECTORS = [
  '.license-card',
  '[class~="license-card"]',
  '#licenseHeading',
  '#licenseBadge',
  '#licensePurchase',
  '#licenseDetail',
  '#licenseCode',
  '#licenseActivate',
  '#licenseMessage',
  '[id^="license" i]',
  '[class^="license-" i]',
  '[class*=" license-" i]',
  'input[placeholder^="GPTL-" i]',
];

const LEGACY_LICENSE_TEXT = [
  '授权验证',
  '验证授权码',
  '重新验证',
  '退出授权',
  '获取授权码',
  '授权额度',
  'gptlock.mv3.cn',
];

function removeNodeAndLegacyCard(node) {
  if (!(node instanceof Element)) return false;
  const card = node.closest('section, article, .card, .license-card');
  (card || node).remove();
  return true;
}

function sanitizeLegacyTooltips() {
  const autoVerify = document.getElementById('autoVerify');
  const title = autoVerify?.getAttribute('title') || '';
  if (autoVerify && /授权码|授权额度|license\s*code/i.test(title)) {
    autoVerify.setAttribute('title', '使用当前 GPTWork 账号权益进行自动验证 / Auto verify with account entitlement');
  }
}

function removeLegacyLicenseUi() {
  let removed = false;

  for (const selector of LEGACY_LICENSE_SELECTORS) {
    for (const node of document.querySelectorAll(selector)) {
      removed = removeNodeAndLegacyCard(node) || removed;
    }
  }

  for (const node of document.querySelectorAll('section, article, div')) {
    if (!(node instanceof HTMLElement) || !node.isConnected) continue;
    const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const hasLegacyMarker = LEGACY_LICENSE_TEXT.some((marker) => text.includes(marker));
    const hasLicenseCode = Boolean(node.querySelector?.('input[placeholder^="GPTL-" i]'));
    if (!hasLegacyMarker && !hasLicenseCode) continue;

    const candidate = node.closest('section, article, .card, .license-card') || node;
    if (candidate.id === 'appShell' || candidate.tagName === 'BODY' || candidate.tagName === 'HTML') continue;
    candidate.remove();
    removed = true;
  }

  sanitizeLegacyTooltips();
  return removed;
}

function openUpdateCenter(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const settingsPage = chrome.runtime.getManifest().options_ui?.page || 'settings-v0521.html';
  const url = chrome.runtime.getURL(`${settingsPage}#updates-auto`);
  void chrome.tabs.create({ url }).then(() => window.close());
}

async function persistRuntimeFingerprint() {
  const payload = {
    schemaVersion: 1,
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

removeLegacyLicenseUi();
void persistRuntimeFingerprint();

const observer = new MutationObserver(() => removeLegacyLicenseUi());
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });

const checkUpdate = document.getElementById('checkUpdate');
checkUpdate?.addEventListener('click', openUpdateCenter, true);

window.addEventListener('pageshow', () => removeLegacyLicenseUi());
window.addEventListener('unload', () => observer.disconnect(), { once: true });