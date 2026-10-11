import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [popup, settings, popupCss, optionsCss, controller, background, work] = await Promise.all([
  read('popup-v0513.html'), read('settings-v0521.html'), read('popup.css'),
  read('options.css'), read('feature-toggle-controller.js'),
  read('background.js'), read('work-mode-controller.js'),
]);

test('server-off Work gate has no visible popup or settings controls even under flex/grid layout', () => {
  for (const [name, html, css] of [
    ['popup', popup, popupCss],
    ['settings', settings, optionsCss],
  ]) {
    const nodes = [...html.matchAll(/<[^>]+\bdata-work-feature\b[^>]*>/g)].map(match => match[0]);
    assert.ok(nodes.length > 0, name);
    assert.ok(nodes.every(tag => /\bhidden\b/.test(tag)), name + ' starts fail-closed');
    assert.match(css, /\[data-work-feature\]\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;/);
  }
  assert.match(popupCss, /\.enable-row\s*\{\s*display:\s*flex/);
  assert.match(optionsCss, /\.check-row,\s*\.radio-row\s*\{\s*display:\s*flex/);
  assert.match(optionsCss, /\.field\s*\{\s*display:\s*grid/);
  assert.doesNotMatch(popup, /无需登录即可查看 GPTWork 界面；启用 Work 模式/);
  assert.doesNotMatch(settings, /GPTWork 总开关控制整个扩展运行；Work 模式/);
  assert.doesNotMatch(settings, /关闭后立即停止 GPTWork；重新开启时会保留各 ChatGPT 标签页各自的 Work\/模型锁定状态/);
  assert.doesNotMatch(settings, /GPTWork 总开关为全局开关；Work 模式/);
});

test('authoritative server readiness and Work gate are surfaced by state snapshot', () => {
  assert.match(background, /function serverWorkFeatureEnabled\(\)\s*\{\s*return serverFeatureSettingsReady === true && currentSettings\.workModeFeatureEnabled === true;/);
  assert.match(background, /workFeatureGateEnabled:\s*serverWorkFeatureEnabled\(\)/);
  assert.match(background, /settings: state \? effectiveSettingsForState\(state\) : \{ \.\.\.currentSettings, workModeFeatureEnabled: serverWorkFeatureEnabled\(\) \}/);
  assert.match(controller, /workFeatureAvailable = value === true;/);
  assert.match(controller, /runtime\?\.workFeatureGateEnabled === true/);
  assert.match(controller, /snapshot\?\.workModeFeatureEnabled === true/);
  assert.match(controller, /snapshot\?\.settings\?\.workModeFeatureEnabled === true/);
  assert.match(work, /workModeFeatureEnabled = message\.settings\?\.workModeFeatureEnabled === true;/);
  assert.match(work, /workModeFeatureEnabled = response\.data\?\.settings\?\.workModeFeatureEnabled === true;/);
});

function fakeNode(hidden = false) {
  return {
    hidden, checked: false, disabled: false, textContent: '', className: '',
    addEventListener() {},
  };
}

async function renderFeatureUi({ serverGate = false, tabGate = true, mirroredSetting = true, noTab = false } = {}) {
  const workNode = fakeNode(true);
  const workToggle = fakeNode();
  const modelToggle = fakeNode();
  const scope = fakeNode();
  const nodes = {
    workModeEnabled: workToggle,
    modelLockEnabled: modelToggle,
    featureScope: scope,
    message: fakeNode(),
  };
  const tab = { id: 41, title: 'ChatGPT', url: 'https://chatgpt.com/c/demo' };
  const messages = [];
  const context = vm.createContext({
    document: {
      getElementById: id => nodes[id] ?? null,
      querySelectorAll: selector => selector === '[data-work-feature]' ? [workNode] : [],
    },
    chrome: {
      tabs: {
        query: async () => noTab ? [] : [tab],
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
      },
      storage: { onChanged: { addListener() {} } },
    },
    window: { addEventListener() {}, dispatchEvent() {} },
    setTimeout, clearTimeout,
    runtimeMessage: async message => {
      messages.push(message.type);
      if (message.type === 'GPTWORK_TAB_FEATURE_GET') return {
        featureState: { workModeEnabled: true, modelLockEnabled: true },
        account: { authenticated: true },
        workModeFeatureEnabled: tabGate,
        settings: { workModeFeatureEnabled: mirroredSetting },
      };
      if (message.type === 'GPTLOCK_GET_STATE') return {
        workFeatureGateEnabled: serverGate,
      };
      throw Error('Unexpected message ' + message.type);
    },
  });
  const script = controller.replace("import { runtimeMessage } from './extension-page-runtime.js';", '');
  vm.runInContext(script, context);
  await new Promise(resolve => setTimeout(resolve, 25));
  return { workNode, workToggle, modelToggle, scope, messages };
}

test('Work gate off hides Work element and keeps Model lock independently functional', async () => {
  const result = await renderFeatureUi({ serverGate: false });
  assert.equal(result.workNode.hidden, true);
  assert.equal(result.workToggle.checked, true, 'per-tab Work preference may survive, but is not presented');
  assert.equal(result.workToggle.disabled, true, 'Work must not remain operable through hidden control');
  assert.equal(result.modelToggle.checked, true);
  assert.equal(result.modelToggle.disabled, false);
  assert.doesNotMatch(result.scope.textContent, /Work/);
  assert.deepEqual(result.messages.sort(), ['GPTLOCK_GET_STATE', 'GPTWORK_TAB_FEATURE_GET']);
});

test('Work appears only after server and tab-runtime both explicitly enable it', async () => {
  for (const config of [
    { serverGate: true, tabGate: false },
    { serverGate: true, mirroredSetting: false },
    { serverGate: false, tabGate: true },
    { serverGate: true, tabGate: true, mirroredSetting: true },
  ]) {
    const result = await renderFeatureUi(config);
    const available = config.serverGate === true && config.tabGate !== false && config.mirroredSetting !== false;
    assert.equal(result.workNode.hidden, !available, JSON.stringify(config));
    assert.equal(result.workToggle.disabled, !available, JSON.stringify(config));
  }
});

test('no active ChatGPT tab never exposes Work gate even if previous state was enabled', async () => {
  const result = await renderFeatureUi({ serverGate: true, noTab: true });
  assert.equal(result.workNode.hidden, true);
  assert.equal(result.workToggle.disabled, true);
  assert.equal(result.modelToggle.checked, false);
  assert.doesNotMatch(result.scope.textContent, /Work/);
});
