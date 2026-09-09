import {
  DISTRIBUTION_CHANNEL,
  STORE_BROWSER,
  STORE_LISTING_URL,
  isStoreManagedExtension,
} from './distribution-channel.js';

const RELEASES_URL = 'https://gptlock.mv3.cn/releases';
const NATIVE_STATE_MESSAGE = 'GPTLOCK_GET_STATE';

const el = {
  badge: document.getElementById('updateStatusBadge'),
  current: document.getElementById('updateCurrentVersion'),
  latest: document.getElementById('updateLatestVersion'),
  core: document.getElementById('updateCoreVersion'),
  progress: document.getElementById('updateProgress'),
  percent: document.getElementById('updatePercent'),
  message: document.getElementById('updateMessage'),
  log: document.getElementById('updateLog'),
  check: document.getElementById('checkUpdateNow'),
  install: document.getElementById('installUpdateNow'),
  release: document.getElementById('openRelease'),
  note: document.querySelector('#updates .permission-note'),
};

function browserLabel() {
  if (STORE_BROWSER === 'chrome') return 'Chrome Web Store';
  if (STORE_BROWSER === 'edge') return 'Microsoft Edge Add-ons';
  return '浏览器扩展商店';
}

function openManagedStore() {
  const url = STORE_LISTING_URL || RELEASES_URL;
  void chrome.tabs.create({ url });
}

function runtimeState() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: NATIVE_STATE_MESSAGE }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) resolve(null);
        else resolve(response.data || null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function init() {
  if (!isStoreManagedExtension()) return;
  const version = chrome.runtime.getManifest().version;
  const label = browserLabel();
  el.current.textContent = version;
  el.latest.textContent = '由商店管理';
  el.badge.textContent = '商店托管';
  el.badge.className = 'update-badge good';
  el.progress.style.width = '100%';
  el.percent.textContent = '100%';
  el.message.textContent = `扩展更新由 ${label} 自动管理；GPTWork 不会下载或替换商店版扩展。`;
  el.log.textContent = `分发渠道：${DISTRIBUTION_CHANNEL}\n扩展版本：${version}\n扩展更新：${label}`;
  el.install.hidden = true;
  el.check.textContent = '打开扩展商店';
  el.release.textContent = STORE_LISTING_URL ? '查看商店页面' : '打开 GPTWork 发布页';
  if (el.note) {
    el.note.textContent = `商店版扩展由 ${label} 更新。Native Core 仍由 GPTWork 安装器维护；浏览器商店不会被 GPTWork 本地安装器替换。`;
  }
  el.check.addEventListener('click', openManagedStore);
  el.release.addEventListener('click', openManagedStore);

  const state = await runtimeState();
  el.core.textContent = state?.nativeStatus?.version || (state?.nativeStatus?.connected ? '已连接' : '离线');
}

void init();
