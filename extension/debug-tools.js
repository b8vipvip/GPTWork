const $ = (id) => document.getElementById(id);
const TOOLS = [
  ['Analyze-GPTWork-Jank.ps1', '分析已采集的卡顿与性能日志'],
  ['GPTWork-Jank-Diagnostic.ps1', '采集 Windows 性能与卡顿诊断数据'],
  ['Run-GPTWork-Jank-Analyzer.bat', '一键启动卡顿日志分析器'],
  ['Run-GPTWork-Jank-Diagnostic.bat', '一键启动卡顿诊断'],
  ['Run-GPTWork-Jank-ETW-Diagnostic.bat', '采集 Windows ETW 事件诊断'],
];
let selectedTabId = null;
let targetTabs = [];
let lastStatus = null;
let refreshBusy = false;

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

function selectedTarget() {
  return targetTabs.find((tab) => String(tab.tabId) === $('targetTab').value) || null;
}

function targetLabel(tab) {
  const title = String(tab.title || 'ChatGPT').replace(/\\s+/g, ' ').trim();
  const windowLabel = tab.sameWindow ? '本窗口' : '其他窗口';
  const position = tab.tabIndex ? '第 ' + tab.tabIndex + ' 个标签' : '位置未知';
  const context = tab.contextKey?.startsWith('conversation:') ? '已有会话' : '新聊天';
  return windowLabel + ' · ' + position + ' · ' + title.slice(0, 50)
    + ' · ' + context + ' · ID ' + tab.tabId;
}

function updateTargetPreview() {
  const tab = selectedTarget();
  if (!tab) {
    $('targetPreview').textContent = targetTabs.length > 1
      ? '检测到多个 ChatGPT 标签页。请明确选择目标，点击“定位并查看该标签页”核对，再执行测试。'
      : '请选择 ChatGPT 标签页。';
    $('locateTab').disabled = true;
    $('runAstra').disabled = true;
    return;
  }
  let path = '/';
  try { path = new URL(tab.url).pathname; } catch {}
  $('targetPreview').textContent = [
    '页面标题：' + (tab.title || 'ChatGPT'),
    '所在窗口：' + (tab.sameWindow ? '调试工具所在的本窗口' : '其他 Chrome 窗口')
      + '（窗口 ID ' + tab.windowId + '，标签栏第 ' + (tab.tabIndex || '?') + ' 个）',
    '页面路径：' + path,
    '标签页 ID：' + tab.tabId,
    '请求锁定器：' + (tab.monitorAttached ? '已连接' : '未连接')
      + (tab.guardStatus ? ' · ' + tab.guardStatus : ''),
  ].join('\\n');
  $('locateTab').disabled = false;
}

function presentProbe(probe) {
  text('probePhase', probe?.phase || '未执行');
  text('probePageModel', probe?.pageModel);
  text('probeBefore', probe?.originalTransportModel);
  text('probeForwarded', probe?.forwardedTransportModel);
  text('probeHttp', probe?.httpStatus);
  text('probeTerminal', probe?.terminalEvent || probe?.networkError);
  text('probeSseDone', probe?.sseTerminalObserved === true ? '已观察到' : '未观察到 / 不适用');
  text('probeServed', probe?.responseModel
    ? probe.responseModel + (probe.responseModelField ? ' · ' + probe.responseModelField : '')
    : '未获取权威证据');
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
  const active = ['dispatching', 'forwarded', 'responding', 'response_finished'].includes(probe?.phase);
  $('runAstra').disabled = active || !selectedTarget();
  $('cancelAstra').disabled = !active;
}

async function refreshTargets() {
  const response = await call('GPTWORK_DEBUG_TOOLS_TARGETS');
  const select = $('targetTab');
  const current = select.value || String(selectedTabId || '');
  select.replaceChildren();
  targetTabs = Array.isArray(response?.tabs) ? response.tabs : [];
  select.add(new Option(targetTabs.length > 1
    ? '请选择目标标签页（不会自动选中）'
    : targetTabs.length ? '请选择目标标签页' : '没有检测到 ChatGPT 标签页', ''));
  for (const tab of targetTabs) {
    select.add(new Option(targetLabel(tab), String(tab.tabId)));
  }
  select.value = targetTabs.some((tab) => String(tab.tabId) === current)
    ? current : targetTabs.length === 1 ? String(targetTabs[0].tabId) : '';
  selectedTabId = Number(select.value) || null;
  updateTargetPreview();
}

async function refreshStatus() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const status = await call('GPTWORK_DEBUG_ASTRA_STATUS');
    lastStatus = status;
    const target = Number($('targetTab').value);
    const probe = target
      ? status?.active?.find((entry) => entry.tabId === target)
        || status?.history?.find((entry) => entry.tabId === target)
        || null : null;
    presentProbe(probe);
  } catch (error) {
    setFeedback('状态读取失败：' + error.message);
  } finally { refreshBusy = false; }
}

$('targetTab').addEventListener('change', () => {
  selectedTabId = Number($('targetTab').value) || null;
  updateTargetPreview();
  void refreshStatus();
});
$('locateTab').addEventListener('click', async () => {
  const tab = selectedTarget();
  if (!tab) return;
  try {
    await call('GPTWORK_DEBUG_TOOLS_FOCUS_TAB', { tabId: tab.tabId, expectedUrl: tab.url });
    setFeedback('已切换到目标 ChatGPT 标签页。请核对浏览器标题和会话内容，然后返回调试工具页执行测试。');
  } catch (error) {
    setFeedback('定位失败：' + error.message);
    await refreshTargets().catch(() => {});
  }
});
$('refresh').addEventListener('click', async () => {
  try { await refreshTargets(); await refreshStatus(); setFeedback('已刷新工具状态。'); }
  catch (error) { setFeedback(error.message); }
});
$('runAstra').addEventListener('click', async () => {
  const tab = selectedTarget();
  if (!tab) { setFeedback('请先选择目标标签页。'); return; }
  const confirmed = window.confirm(
    '确认向以下 ChatGPT 标签页发送一条真实测试消息？\\n\\n'
    + '标题：' + (tab.title || 'ChatGPT') + '\\n'
    + '窗口：' + tab.windowId + ' · 第 ' + (tab.tabIndex || '?') + ' 个标签\\n'
    + '标签页 ID：' + tab.tabId + '\\n'
    + '地址：' + tab.url + '\\n\\n'
    + '测试消息：计算 12×13，只输出整数。\\n'
    + '本次将尝试请求 gpt-6-astra-wm，可能消耗额度。'
  );
  if (!confirmed) return;
  const tabId = tab.tabId;
  $('runAstra').disabled = true;
  setFeedback('正在切换到 ChatGPT 标签页，发送固定测试消息并等待实际网络证据…');
  try {
    const probe = await call('GPTWORK_DEBUG_ASTRA_START', { tabId, expectedUrl: tab.url });
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
