const latestVersion = document.getElementById('releaseLatestVersion');
const productVersion = document.getElementById('releaseProductVersion');
const mirrorState = document.getElementById('releaseMirrorState');
const mirroredAt = document.getElementById('releaseMirroredAt');
const source = document.getElementById('releaseSource');
const message = document.getElementById('releaseMirrorMessage');
const warning = document.getElementById('releaseMirrorWarning');
const details = document.getElementById('releaseMirrorDetails');
const syncButton = document.getElementById('releaseSyncButton');
const progressBar = document.getElementById('releaseMirrorProgress');
const progressPercent = document.getElementById('releaseMirrorPercent');
let lastMirrorDiagnostics = null;

const WARNING_TEXT = {
  private_release_token_required: '服务进程未检测到 GPTLOCK_GITHUB_TOKEN / GH_TOKEN。请把只读 GitHub Token 配置到 gptlock-license.service 使用的环境文件并重启服务。',
  release_token_invalid: 'GitHub 已拒绝当前 Release Token（401）。请更换有效的只读 Token 后重启服务。',
  release_token_forbidden: 'GitHub 已识别当前 Token，但它没有读取 GPTWork 私有 Release 的权限（403）。',
  release_feed_unavailable: '尚未取得可发布的正式 Release。请查看下方同步阶段与 lastError；可能是 GitHub Release API、HTTPS 网络或资产下载不可用。',
  release_mirror_storage_unavailable: 'Release 镜像存储目录不可用。请检查持久化数据目录权限。',
  release_mirror_sync_failed: '本轮 Release 同步失败；如果已有完整镜像，客户端仍会继续使用上一次版本。',
  release_history_partial: '最新正式版已经完整发布；部分历史版本回填失败，不影响客户端检查和更新最新版本。',
};

const STAGE_TEXT = {
  idle: '等待同步',
  fetching_release_feed: '正在读取 GitHub 正式 Release 列表',
  downloading_latest: '正在下载并校验最新正式版',
  publishing_latest: '最新正式版已校验，正在发布官网索引',
  backfilling_history: '最新正式版已发布，正在回填历史版本',
  completed: '同步完成',
  failed: '同步失败',
};

function localDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

function duration(ms) {
  const value = Math.max(0, Number(ms || 0));
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.floor((value % 60_000) / 1000)}s`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function progressValue(sync) {
  const stage = sync?.stage || 'idle';
  const completed = Math.max(0, Number(sync?.completedAssets || 0));
  const total = Math.max(0, Number(sync?.totalAssets || 0));
  const assetRatio = total ? Math.min(1, completed / total) : 0;
  if (stage === 'fetching_release_feed') return 5;
  if (stage === 'downloading_latest') return Math.round(10 + assetRatio * 65);
  if (stage === 'publishing_latest') return 80;
  if (stage === 'backfilling_history') {
    const index = Math.max(0, Number(sync?.historyIndex || 0));
    const historyTotal = Math.max(0, Number(sync?.historyTotal || 0));
    return Math.round(85 + (historyTotal ? Math.min(1, index / historyTotal) * 14 : 0));
  }
  if (stage === 'completed') return 100;
  if (stage === 'failed') return Math.max(5, Math.min(99, Number(progressBar?.dataset.lastPercent || 5)));
  return 0;
}

function stateText(data, sync) {
  if (sync?.inProgress) return '同步中';
  if (data.latestVersion) return data.warning === 'release_history_partial' ? '可用 · 历史回填异常' : '可用';
  if (data.warning === 'private_release_token_required') return '缺少 Release Token';
  if (data.warning === 'release_token_invalid') return 'Release Token 无效';
  if (data.warning === 'release_token_forbidden') return 'Release Token 权限不足';
  if (data.warning === 'release_mirror_storage_unavailable') return '镜像存储不可用';
  if (data.warning) return '同步失败';
  return '等待同步';
}

function progressMessage(data, sync) {
  if (!sync) return data.latestVersion ? `官网镜像已发布 v${data.latestVersion}。` : '尚未开始 Release 镜像同步。';
  const label = STAGE_TEXT[sync.stage] || sync.stage || '等待同步';
  if (sync.stage === 'downloading_latest' || sync.stage === 'backfilling_history') {
    const active = Array.isArray(sync.activeAssets) && sync.activeAssets.length ? sync.activeAssets.join(', ') : (sync.currentAsset || '等待资产');
    return `${label} · ${sync.releaseTag || '—'} · 已完成 ${sync.completedAssets || 0}/${sync.totalAssets || 0} · 当前 ${active}`;
  }
  if (sync.stage === 'completed' && data.latestVersion) return `官网镜像已发布 v${data.latestVersion}，客户端可以从服务端检查并下载安装更新。`;
  return `${label}${sync.releaseTag ? ` · ${sync.releaseTag}` : ''}`;
}

function render(data) {
  const releases = Array.isArray(data.releases) ? data.releases : [];
  const newest = releases[0] || null;
  const assetCount = releases.reduce((sum, release) => sum + (Array.isArray(release.assets) ? release.assets.length : 0), 0);
  if (data.mirror) lastMirrorDiagnostics = data.mirror;
  const mirror = data.mirror || lastMirrorDiagnostics;
  const sync = data.sync || mirror?.progress || null;

  latestVersion.textContent = data.latestVersion ? `v${data.latestVersion}` : '—';
  if (productVersion) productVersion.textContent = data.currentVersion ? `v${data.currentVersion}` : '—';
  mirrorState.textContent = stateText(data, sync);
  mirroredAt.textContent = localDate(data.mirroredAt);
  source.textContent = data.source || 'local';
  message.textContent = progressMessage(data, sync);

  const percent = progressValue(sync);
  if (progressBar) {
    progressBar.style.width = `${percent}%`;
    progressBar.dataset.lastPercent = String(percent);
  }
  if (progressPercent) progressPercent.textContent = `${percent}%`;

  if (data.warning) {
    warning.hidden = false;
    warning.textContent = WARNING_TEXT[data.warning] || `Release 镜像警告：${data.warning}`;
  } else {
    warning.hidden = true;
    warning.textContent = '';
  }

  details.textContent = [
    `productVersion: ${data.currentVersion || '—'}`,
    `source: ${data.source || 'local'}`,
    `latestVersion: ${data.latestVersion || '—'}`,
    `mirroredAt: ${data.mirroredAt || '—'}`,
    `generation: ${data.generation || '—'}`,
    `releaseCount: ${releases.length}`,
    `assetCount: ${assetCount}`,
    `latestTag: ${newest?.tag || '—'}`,
    `warning: ${data.warning || 'none'}`,
    '',
    '[live progress]',
    `stage: ${sync?.stage || 'idle'}`,
    `elapsed: ${duration(sync?.elapsedMs)}`,
    `releaseTag: ${sync?.releaseTag || '—'}`,
    `assets: ${sync?.completedAssets || 0}/${sync?.totalAssets || 0}`,
    `activeAssets: ${Array.isArray(sync?.activeAssets) && sync.activeAssets.length ? sync.activeAssets.join(', ') : '—'}`,
    `history: ${sync?.historyIndex || 0}/${sync?.historyTotal || 0}`,
    `transport: ${sync?.transport || mirror?.lastTransport || '—'}`,
    ...(mirror ? [
      '',
      '[transport diagnostics]',
      `tokenConfigured: ${mirror.tokenConfigured ? 'yes' : 'no'}`,
      `storageAvailable: ${mirror.storageAvailable ? 'yes' : 'no'}`,
      `transportPolicy: ${mirror.transportPolicy || 'auto'}`,
      `lastTransport: ${mirror.lastTransport || '—'}`,
      `proxyConfigured: ${mirror.proxyConfigured ? 'yes' : 'no'}`,
      `proxyInvalid: ${mirror.proxyInvalid ? 'yes' : 'no'}`,
      `assetTimeoutMs: ${mirror.assetTimeoutMs || '—'}`,
      `lastAttemptAt: ${mirror.lastAttemptAt || '—'}`,
      `lastSuccessAt: ${mirror.lastSuccessAt || '—'}`,
      `lastErrorAt: ${mirror.lastErrorAt || '—'}`,
      `lastError: ${mirror.lastError || 'none'}`,
      `historyFailures: ${Array.isArray(mirror.historyFailures) ? mirror.historyFailures.length : 0}`,
    ] : []),
  ].join('\n');
}

async function refresh() {
  try {
    render(await api('/admin/api/releases'));
  } catch (error) {
    if (error.status === 401) return;
    mirrorState.textContent = '读取失败';
    message.textContent = error.message;
    warning.hidden = false;
    warning.textContent = `Release 镜像状态读取失败：${error.message}`;
  }
}

syncButton?.addEventListener('click', async () => {
  const original = syncButton.textContent;
  syncButton.disabled = true;
  syncButton.textContent = '同步中…';
  message.textContent = '正在提交 Release 镜像同步；页面会每 2 秒刷新真实进度…';
  try {
    render(await api('/admin/api/releases/sync', { method: 'POST', body: '{}' }));
  } catch (error) {
    warning.hidden = false;
    warning.textContent = `Release 同步请求失败：${error.message}`;
  } finally {
    syncButton.disabled = false;
    syncButton.textContent = original;
    void refresh();
  }
});

if (latestVersion) {
  void refresh();
  setInterval(() => void refresh(), 2000);
}

function guideNode(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
}

async function installGuideStepsEditor() {
  if (document.body.dataset.adminPage !== 'website') return;
  if (new URLSearchParams(location.search).get('view') !== 'guide') return;
  const host = document.getElementById('pagesEditor');
  if (!host) return;

  const mount = async () => {
    const cards = [...host.querySelectorAll('.module-editor')];
    const card = cards.find((entry) => entry.querySelector('.module-title small')?.textContent?.includes('guide-steps'));
    if (!card || card.dataset.guideStepEditor === '1') return false;
    let data;
    try { data = await api('/admin/api/website'); } catch { return false; }
    const module = data.config?.pages?.guide?.modules?.find((entry) => entry.id === 'guide-steps');
    if (!module || !Array.isArray(module.items)) return false;

    card.dataset.guideStepEditor = '1';
    const oldHint = [...card.children].find((entry) => entry.classList?.contains('muted'));
    oldHint?.remove();
    const intro = guideNode('p', 'muted', '教程步骤的编号与页面结构由系统保护；下面的步骤标题和说明可以直接编辑并保存。');
    const wrap = guideNode('div', 'nested-items');

    module.items.forEach((item, index) => {
      const row = guideNode('div', 'nested-item');
      const titleLabel = guideNode('label');
      titleLabel.append(guideNode('span', 'cms-field-label', `步骤 ${String(index + 1).padStart(2, '0')} 标题`));
      const titleInput = document.createElement('input');
      titleInput.maxLength = 160;
      titleInput.value = item.title || '';
      titleLabel.append(titleInput);

      const bodyLabel = guideNode('label', 'wide');
      bodyLabel.append(guideNode('span', 'cms-field-label', '步骤说明'));
      const bodyInput = document.createElement('textarea');
      bodyInput.rows = 3;
      bodyInput.maxLength = 1200;
      bodyInput.value = item.body || '';
      bodyLabel.append(bodyInput);

      const status = guideNode('small', 'cms-field-status');
      const save = guideNode('button', 'cms-field-save', '保存');
      save.type = 'button';
      save.addEventListener('click', async () => {
        const original = save.textContent;
        save.disabled = true;
        save.textContent = '保存中…';
        status.textContent = '正在保存';
        try {
          const latest = await api('/admin/api/website');
          const guideModule = latest.config?.pages?.guide?.modules?.find((entry) => entry.id === 'guide-steps');
          if (!guideModule?.items?.[index]) throw new Error('教程步骤配置不存在，请刷新页面重试');
          guideModule.items[index].title = titleInput.value;
          guideModule.items[index].body = bodyInput.value;
          const saved = await api('/admin/api/website', { method: 'PUT', body: JSON.stringify({ config: latest.config }) });
          const savedItem = saved.config?.pages?.guide?.modules?.find((entry) => entry.id === 'guide-steps')?.items?.[index];
          if (!savedItem) throw new Error('保存后未读取到教程步骤');
          titleInput.value = savedItem.title || '';
          bodyInput.value = savedItem.body || '';
          status.textContent = '已保存并实时同步到官网';
          const globalMessage = document.getElementById('websiteMessage');
          if (globalMessage) { globalMessage.textContent = `教程步骤 ${index + 1} 已保存并实时生效。`; globalMessage.className = 'message good'; }
        } catch (error) {
          status.textContent = '保存失败';
          const globalMessage = document.getElementById('websiteMessage');
          if (globalMessage) { globalMessage.textContent = error.message; globalMessage.className = 'message bad'; }
        } finally {
          save.disabled = false;
          save.textContent = original;
        }
      });
      const footer = guideNode('span', 'cms-field-footer');
      footer.append(status, save);
      row.append(titleLabel, bodyLabel, footer);
      wrap.append(row);
    });
    card.append(intro, wrap);
    return true;
  };

  if (await mount()) return;
  const observer = new MutationObserver(() => { void mount().then((done) => { if (done) observer.disconnect(); }); });
  observer.observe(host, { childList: true, subtree: true });
}

void installGuideStepsEditor();
