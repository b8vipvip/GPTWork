const $ = (id) => document.getElementById(id);
const TOOLS = [
  ['Analyze-GPTWork-Jank.ps1', '分析已采集的卡顿与性能日志'],
  ['GPTWork-Jank-Diagnostic.ps1', '采集 Windows 性能与卡顿诊断数据'],
  ['Run-GPTWork-Jank-Analyzer.bat', '一键启动卡顿日志分析器'],
  ['Run-GPTWork-Jank-Diagnostic.bat', '一键启动卡顿诊断'],
  ['Run-GPTWork-Jank-ETW-Diagnostic.bat', '采集 Windows ETW 事件诊断'],
];
let selectedTabId = null;
let lastStatus = null;
let refreshBusy = false;
let targetTabs = new Map();

function toolList() {
  const root = $('windowsTools');
  for (const [name, description] of TOOLS) {
    const item = document.createElement('div');
    item.className = 'tool-item';
    const copy = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = name;
    const subtitle = document.createElement('small');
    subtitle.textContent = description;
    copy.append(heading, subtitle);
    const link = document.createElement('a');
    link.textContent = '查看脚本 ↗';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.href = 'https://github.com/b8vipvip/GPTWork/blob/main/tools/windows/' + encodeURIComponent(name);
    item.append(copy, link);
    root.append(item);
  }
}

function call(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response?.ok) {
        reject(new Error(response?.error || '调试工具调用失败'));
      } else resolve(response.data);
    });
  });
}

function setFeedback(message) { $('feedback').textContent = message; }
function text(id, value) { $(id).textContent = value == null || value === '' ? '—' : String(value); }

function presentProbe(probe) {
  text('probePhase', probe?.phase || '未执行');
  text('probePageModel', probe?.pageModel);
  text('probeBefore', probe?.originalTransportModel);
  text('probeForwarded', probe?.forwardedTransportModel);
  text('probeHttp', probe?.httpStatus);
  text('probeTerminal', probe?.terminalEvent || probe?.networkError);
  text('probeNetworkError', probe?.networkError);
  text('probeStreamStage', probe?.streamStage);
  text('probeSseDone', probe?.sseTerminalObserved === true ? '已观察到' : '未观察到 / 不适用');
  text('probeServed', probe?.responseModel
    ? probe.responseModel + (probe.responseModelField ? ' · ' + probe.responseModelField : '')
    : '未获取权威证据');
  text('probeDefaultModel', probe?.responseDefaultModel);
  const outcomes = {
    not_forwarded: '未确认转发',
    failed: '请求失败',
    transport_completed: 'HTTP / 网络流已完成',
    awaiting_stream_terminal: '等待流式终态',
    awaiting_response: '等待 HTTP 响应',
  };
  text('probeOutcome', probe ? outcomes[probe.requestOutcome] || probe.requestOutcome : '—');
  const verdicts = {
    unverified: '未验证（不等于 Astra 成功）',
    astra_confirmed: '响应字段确认 Astra',
    different_model: '响应显示其他模型',
  };
  text('probeVerdict', probe ? verdicts[probe.modelVerdict] || probe.modelVerdict : '未验证');
  text('probeRequestId', probe?.requestId || probe?.fetchRequestId);
  text('probeReply', probe?.responseTextSnippet);
  text('probeAssistantSettled', probe?.assistantSettled === true ? '是' : probe?.assistantSettled === false ? '未确认' : '等待中');
  text('probeAssistantReason', probe?.assistantObservationReason);
  const active = ['dispatching', 'forwarded', 'responding', 'response_finished'].includes(probe?.phase);
  $('runAstra').disabled = active || !$('targetTab').value;
  $('cancelAstra').disabled = !active;
}

async function refreshTargets() {
  const response = await call('GPTWORK_DEBUG_TOOLS_TARGETS');
  const select = $('targetTab');
  const current = select.value || String(selectedTabId || '');
  select.replaceChildren();
  const tabs = response?.tabs || [];
  targetTabs = new Map(tabs.map((tab) => [Number(tab.tabId), tab]));
  if (!tabs.length) {
    const option = new Option('没有检测到 ChatGPT 标签页', '');
    select.add(option);
  }
  for (const tab of tabs) {
    const position = Number.isInteger(tab.tabIndex) ? '第 ' + (tab.tabIndex + 1) + ' 个' : '位置未知';
    const title = String(tab.title || 'ChatGPT').replace(/\s+/g, ' ').slice(0, 45);
    const name = '窗口 ' + tab.windowId + ' · ' + position + '标签 · ' + title
      + ' · ID ' + tab.tabId
      + (tab.contextKey?.startsWith('conversation:') ? ' · 已有会话' : ' · 新聊天')
      + (tab.active ? ' · 当前窗口已选中' : '');
    select.add(new Option(name, String(tab.tabId)));
  }
  select.value = tabs.some((tab) => String(tab.tabId) === current)
    ? current : tabs.length ? String(tabs[0].tabId) : '';
  selectedTabId = Number(select.value) || null;
  const selected = targetTabs.get(selectedTabId);
  text('targetTabInfo', selected
    ? 'Chrome 标签页 ID：' + selected.tabId
      + '；窗口 ID：' + selected.windowId
      + '；标签位置：' + (Number.isInteger(selected.tabIndex) ? selected.tabIndex + 1 : '未知')
      + '。可点击“定位标签页”确认目标。'
    : '没有可用的 ChatGPT 标签页。');
}

async function refreshStatus() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const status = await call('GPTWORK_DEBUG_ASTRA_STATUS');
    lastStatus = status;
    const target = Number($('targetTab').value);
    const probe = status?.active?.find((entry) => entry.tabId === target)
      || status?.history?.find((entry) => entry.tabId === target)
      || (!target ? status?.active?.[0] || status?.history?.[0] : null);
    presentProbe(probe);
  } catch (error) {
    setFeedback('状态读取失败：' + error.message);
  } finally { refreshBusy = false; }
}

$('targetTab').addEventListener('change', () => {
  selectedTabId = Number($('targetTab').value) || null;
  const selected = targetTabs.get(selectedTabId);
  text('targetTabInfo', selected
    ? 'Chrome 标签页 ID：' + selected.tabId
      + '；窗口 ID：' + selected.windowId
      + '；标签位置：' + (Number.isInteger(selected.tabIndex) ? selected.tabIndex + 1 : '未知')
      + '。可点击“定位标签页”确认目标。'
    : '没有可用的 ChatGPT 标签页。');
  void refreshStatus();
});
$('locateTab').addEventListener('click', async () => {
  const tabId = Number($('targetTab').value);
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    setFeedback('已定位 Chrome 标签页 ID ' + tabId + '。此操作不发送请求。');
  } catch (error) {
    setFeedback('定位失败，标签页可能已关闭：' + String(error?.message || error));
    await refreshTargets();
  }
});
$('refresh').addEventListener('click', async () => {
  try { await refreshTargets(); await refreshStatus(); setFeedback('已刷新工具状态。'); }
  catch (error) { setFeedback(error.message); }
});
$('runAstra').addEventListener('click', async () => {
  const tabId = Number($('targetTab').value);
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  $('runAstra').disabled = true;
  setFeedback('正在切换到 ChatGPT 标签页，发送固定测试消息并等待实际网络证据…');
  try {
    const probe = await call('GPTWORK_DEBUG_ASTRA_START', { tabId });
    presentProbe(probe);
    setFeedback(probe?.phase === 'failed'
      ? '发送阶段失败：' + (probe.error || '请查看运行日志')
      : '已触发测试。可切回此工具页查看 HTTP、流终态和真实模型证据。');
  } catch (error) { setFeedback('执行失败：' + error.message); }
  await refreshStatus();
});
$('cancelAstra').addEventListener('click', async () => {
  const tabId = Number($('targetTab').value);
  if (!tabId) return;
  try {
    await call('GPTWORK_DEBUG_ASTRA_CANCEL', { tabId });
    setFeedback('已取消后续调试等待；已经发送到 ChatGPT 的请求不会撤回。');
  } catch (error) { setFeedback(error.message); }
  await refreshStatus();
});
$('exportResults').addEventListener('click', () => {
  const safe = { exportedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version,
    active: lastStatus?.active || [], history: lastStatus?.history || [] };
  const url = URL.createObjectURL(new Blob([JSON.stringify(safe, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'gptwork-astra-debug-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

toolList();
void refreshTargets().then(refreshStatus).catch((error) => setFeedback(error.message));
setInterval(() => { void refreshStatus(); }, 2500);
