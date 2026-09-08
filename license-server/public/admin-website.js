import { createTextStyleToolbar } from '/rich-text-style.js';

const $ = (id) => document.getElementById(id);
const OPERATIONAL_VIEWS = ['guide', 'releases', 'issues', 'support', 'account'];
const VALID_VIEWS = new Set(['global', 'home', ...OPERATIONAL_VIEWS, 'legal']);
const requestedView = new URLSearchParams(location.search).get('view') || 'global';
const state = {
  config: null,
  persisted: null,
  updatedAt: null,
  view: VALID_VIEWS.has(requestedView) ? requestedView : 'global',
};
let saveTail = Promise.resolve();
const autoTimers = new Map();

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
function clone(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
function message(value, tone = '') {
  const target = $('websiteMessage');
  if (!target) return;
  target.textContent = value || '';
  target.className = `message ${tone}`.trim();
}
function node(tag, className = '', text = '') {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== '') item.textContent = text;
  return item;
}
function label(title, control) {
  const wrap = node('label');
  wrap.append(node('span', 'cms-field-label', title), control);
  return wrap;
}
function input(value = '', type = 'text') {
  const item = document.createElement('input');
  item.type = type;
  item.value = value ?? '';
  return item;
}
function textarea(value = '', rows = 4) {
  const item = document.createElement('textarea');
  item.rows = rows;
  item.value = value ?? '';
  return item;
}
function checkbox(checked = false) {
  const item = input('', 'checkbox');
  item.checked = Boolean(checked);
  return item;
}
function button(text, handler, className = '') {
  const item = node('button', className, text);
  item.type = 'button';
  item.addEventListener('click', handler);
  return item;
}
function localDate(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '尚未保存官网配置' : `最近保存：${date.toLocaleString('zh-CN', { hour12: false })}`;
}
function savedTime() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
function getAt(root, path) {
  let value = root;
  for (const key of path) value = value?.[key];
  return value;
}
function setAt(root, path, value) {
  let target = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const nextKey = path[index + 1];
    if (target[key] === undefined || target[key] === null || typeof target[key] !== 'object') {
      target[key] = typeof nextKey === 'number' ? [] : {};
    }
    target = target[key];
  }
  target[path.at(-1)] = clone(value);
}
function equalValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function attach(control, object, key, parser = (value) => value) {
  const event = control.type === 'checkbox' ? 'change' : 'input';
  control.addEventListener(event, () => {
    object[key] = parser(control.type === 'checkbox' ? control.checked : control.value);
  });
  return control;
}
function toggleRowDisabled(row, enabled) { row.classList.toggle('is-disabled', !enabled); }
function textStylePath(path, key = path.at(-1)) { return [...path.slice(0, -1), 'styles', key]; }
function ensureFieldStyle(object, key) {
  object.styles ||= {};
  object.styles[key] ||= {};
  return object.styles[key];
}
function enqueue(task) {
  const run = saveTail.then(task, task);
  saveTail = run.catch(() => {});
  return run;
}
async function verifyPublicPaths(paths) {
  const data = await api(`/site/api/website?_=${Date.now()}`);
  for (const path of paths) {
    if (!equalValue(getAt(data.config, path), getAt(state.persisted, path))) {
      throw new Error(`公开官网配置校验失败：${path.join('.')}`);
    }
  }
  return data;
}
function updateSavedStamp(data) {
  state.updatedAt = data.updatedAt;
  if ($('websiteUpdated')) $('websiteUpdated').textContent = localDate(state.updatedAt);
}
async function persistPaths(paths, { saveButton = null, statusNode = null, success = '已保存并实时同步到官网。', rerender = false } = {}) {
  if (!state.config || !state.persisted || !paths.length) return;
  const uniquePaths = [...new Map(paths.map((path) => [JSON.stringify(path), path])).values()];
  const original = saveButton?.textContent || '保存';
  if (saveButton) { saveButton.disabled = true; saveButton.textContent = '保存中…'; }
  if (statusNode) statusNode.textContent = '正在保存';
  return enqueue(async () => {
    try {
      const next = clone(state.persisted);
      for (const path of uniquePaths) setAt(next, path, getAt(state.config, path));
      const data = await api('/admin/api/website', { method: 'PUT', body: JSON.stringify({ config: next }) });
      state.persisted = clone(data.config);
      for (const path of uniquePaths) setAt(state.config, path, getAt(data.config, path));
      updateSavedStamp(data);
      await verifyPublicPaths(uniquePaths);
      if (statusNode) statusNode.textContent = `已保存 ${savedTime()}`;
      message(success, 'good');
      if (rerender) renderCurrentView();
    } catch (error) {
      if (statusNode) statusNode.textContent = '保存失败';
      message(error.message, 'bad');
      throw error;
    } finally {
      if (saveButton) { saveButton.disabled = false; saveButton.textContent = original; }
    }
  }).catch(() => {});
}
function autoPersistPath(path, success = '选择已自动保存并实时同步到官网。') {
  return persistPaths([path], { success });
}
function scheduleAutoPersist(path, success = '文本样式已自动保存并实时同步到官网。') {
  const key = JSON.stringify(path);
  clearTimeout(autoTimers.get(key));
  autoTimers.set(key, setTimeout(() => {
    autoTimers.delete(key);
    void autoPersistPath(path, success);
  }, 320));
}
function installTextStyleEditor(wrap, control, object, key, path) {
  if (!wrap || !control || !object) return null;
  wrap.querySelector(':scope > .cms-style-toolbar')?.remove();
  wrap.classList.add('has-rich-style');
  const targetPath = textStylePath(path, key);
  const style = ensureFieldStyle(object, key);
  const toolbar = createTextStyleToolbar({
    control,
    value: style,
    onChange: (next) => {
      object.styles[key] = next;
      scheduleAutoPersist(targetPath);
    },
  });
  wrap.insertBefore(toolbar, control);
  return targetPath;
}
function addSaveFooter(wrap, path, extraPaths = []) {
  if (!wrap) return wrap;
  wrap.querySelector(':scope > .cms-field-footer')?.remove();
  wrap.dataset.fieldSaveReady = '1';
  wrap.classList.add('cms-field');
  const footer = node('span', 'cms-field-footer');
  const status = node('small', 'cms-field-status');
  const save = button('保存', () => void persistPaths([path, ...extraPaths], {
    saveButton: save,
    statusNode: status,
    success: '该字段已保存并实时同步到官网。',
  }), 'cms-field-save');
  footer.append(status, save);
  wrap.append(footer);
  return wrap;
}
function savedLabel(title, control, path, options = {}) {
  const wrap = label(title, control);
  if (options.wide) wrap.classList.add('wide');
  const extraPaths = [];
  if (options.rich && options.object && options.key) {
    const stylePath = installTextStyleEditor(wrap, control, options.object, options.key, path);
    if (stylePath) extraPaths.push(stylePath);
  }
  addSaveFooter(wrap, path, extraPaths);
  return wrap;
}
function textField(grid, object, key, title, options = {}, path) {
  const control = options.multiline ? textarea(object[key], options.rows || 4) : input(object[key]);
  if (options.max) control.maxLength = options.max;
  attach(control, object, key);
  grid.append(savedLabel(title, control, path, {
    wide: options.wide,
    rich: options.rich !== false,
    object,
    key,
  }));
  return control;
}
function hrefField(grid, object, key, title, path, wide = false) {
  const control = input(object[key]);
  control.placeholder = '/guide 或 https://...';
  attach(control, object, key);
  grid.append(savedLabel(title, control, path, { wide }));
  return control;
}
function bindStaticField(control, object, key) {
  if (!control || control.dataset.cmsValueBound === '1') return;
  control.dataset.cmsValueBound = '1';
  control.addEventListener('input', () => { object[key] = control.value; });
}
function installSiteFieldSaves() {
  const fields = [
    ['siteBrandName', ['site', 'brandName'], true],
    ['siteTitle', ['site', 'title'], false],
    ['siteDescription', ['site', 'description'], false],
    ['siteFooterText', ['site', 'footerText'], true],
  ];
  for (const [id, path, rich] of fields) {
    const control = $(id);
    const wrap = control?.closest('label');
    if (!control || !wrap) continue;
    bindStaticField(control, state.config.site, path.at(-1));
    wrap.querySelector(':scope > .cms-style-toolbar')?.remove();
    wrap.querySelector(':scope > .cms-field-footer')?.remove();
    wrap.classList.remove('has-rich-style');
    const extraPaths = [];
    if (rich) {
      const object = getAt(state.config, path.slice(0, -1));
      const stylePath = installTextStyleEditor(wrap, control, object, path.at(-1), path);
      if (stylePath) extraPaths.push(stylePath);
    }
    addSaveFooter(wrap, path, extraPaths);
  }
}

function renderNavigation() {
  const wrap = $('navigationEditor');
  if (!wrap) return;
  wrap.replaceChildren();
  const rows = [...(state.config.navigation || [])].sort((a, b) => Number(a.order) - Number(b.order));
  for (const item of rows) {
    const index = state.config.navigation.indexOf(item);
    const base = ['navigation', index];
    const row = node('div', 'module-editor nav-row');
    toggleRowDisabled(row, item.enabled);
    const enabled = attach(checkbox(item.enabled), item, 'enabled', Boolean);
    enabled.addEventListener('change', () => {
      toggleRowDisabled(row, enabled.checked);
      void autoPersistPath([...base, 'enabled'], '导航显示状态已自动保存并实时生效。');
    });
    const enabledWrap = node('label', 'checkline');
    enabledWrap.append(enabled, document.createTextNode('显示'));
    const remove = button('删除导航', async () => {
      state.config.navigation = state.config.navigation.filter((entry) => entry !== item);
      renderNavigation();
      await persistPaths([['navigation']], { success: '导航已删除并实时生效。' });
    }, 'danger');
    const head = node('div', 'nav-row-head');
    head.append(enabledWrap, remove);

    const labelInput = attach(input(item.label), item, 'label');
    labelInput.maxLength = 80;
    const hrefInput = attach(input(item.href), item, 'href');
    hrefInput.placeholder = '/path 或 https://...';
    const orderInput = attach(input(item.order, 'number'), item, 'order', Number);
    orderInput.min = '-9999';
    orderInput.max = '9999';
    const fields = node('div', 'nav-fields');
    fields.append(
      savedLabel('名称', labelInput, [...base, 'label'], { rich: true, object: item, key: 'label' }),
      savedLabel('链接', hrefInput, [...base, 'href']),
      savedLabel('顺序', orderInput, [...base, 'order']),
    );
    row.append(head, fields);
    wrap.append(row);
  }
  if (!rows.length) wrap.append(node('div', 'module-empty', '当前没有顶部导航。'));
}

function itemsEditor(grid, module, modulePath, maxItems) {
  const wrap = node('div', 'nested-items');
  (module.items || []).forEach((item, index) => {
    const row = node('div', 'nested-item');
    const base = [...modulePath, 'items', index];
    textField(row, item, 'title', `项目 ${index + 1} 标题`, { max: 160 }, [...base, 'title']);
    textField(row, item, 'body', `项目 ${index + 1} 说明`, { multiline: true, rows: 3, max: 1200 }, [...base, 'body']);
    wrap.append(row);
  });
  const controls = node('div', 'module-controls');
  if ((module.items || []).length < maxItems) {
    controls.append(button('增加项目', async () => {
      module.items ||= [];
      module.items.push({ title: `项目 ${module.items.length + 1}`, body: '' });
      renderHomeModules();
      await persistPaths([[...modulePath, 'items']], { success: '项目已新增并实时生效。' });
    }));
  }
  if ((module.items || []).length > 1) {
    controls.append(button('删除最后一项', async () => {
      module.items.pop();
      renderHomeModules();
      await persistPaths([[...modulePath, 'items']], { success: '项目已删除并实时生效。' });
    }, 'danger'));
  }
  wrap.append(controls);
  grid.append(wrap);
}
function renderHomeFields(grid, module, modulePath) {
  const p = (key) => [...modulePath, key];
  if (module.type === 'hero') {
    textField(grid, module, 'badge', '顶部徽标', { wide: true, max: 160 }, p('badge'));
    textField(grid, module, 'title', '主标题', { multiline: true, rows: 2, max: 300 }, p('title'));
    textField(grid, module, 'body', '主说明', { wide: true, multiline: true, rows: 7, max: 5000 }, p('body'));
    textField(grid, module, 'primaryLabel', '主按钮文字', { max: 80 }, p('primaryLabel'));
    hrefField(grid, module, 'primaryHref', '主按钮链接', p('primaryHref'));
    textField(grid, module, 'secondaryLabel', '下载按钮文字', { max: 80 }, p('secondaryLabel'));
    hrefField(grid, module, 'secondaryHref', '下载按钮链接', p('secondaryHref'));
    textField(grid, module, 'tertiaryLabel', '第三按钮文字', { max: 80 }, p('tertiaryLabel'));
    hrefField(grid, module, 'tertiaryHref', '第三按钮链接', p('tertiaryHref'));
    textField(grid, module, 'statusLabel', '状态徽标', { max: 100 }, p('statusLabel'));
    textField(grid, module, 'modelValue', '锁定模型值', { max: 100 }, p('modelValue'));
    textField(grid, module, 'modeValue', 'Work 模式值', { max: 100 }, p('modeValue'));
    textField(grid, module, 'stateValue', '状态值', { max: 100 }, p('stateValue'));
    textField(grid, module, 'reasoningValue', '推理偏好值', { max: 100 }, p('reasoningValue'));
    textField(grid, module, 'protectionValue', '异常保护值', { max: 140 }, p('protectionValue'));
    textField(grid, module, 'noteText', '右侧提示卡', { multiline: true, rows: 2, max: 200 }, p('noteText'));
    textField(grid, module, 'signalTitle', '右侧信号卡标题', { max: 100 }, p('signalTitle'));
    textField(grid, module, 'signalText', '右侧信号卡说明', { wide: true, multiline: true, rows: 2, max: 300 }, p('signalText'));
  } else if (module.type === 'features') {
    textField(grid, module, 'title', '模块标题', { multiline: true, rows: 2, max: 300 }, p('title'));
    textField(grid, module, 'lead', '模块说明', { multiline: true, rows: 3, max: 1200 }, p('lead'));
    itemsEditor(grid, module, modulePath, 6);
  } else if (module.type === 'workflow') {
    textField(grid, module, 'title', '模块标题', { multiline: true, rows: 2, max: 300 }, p('title'));
    textField(grid, module, 'lead', '模块说明', { multiline: true, rows: 3, max: 1200 }, p('lead'));
    itemsEditor(grid, module, modulePath, 8);
    textField(grid, module, 'primaryLabel', '主按钮文字', { max: 80 }, p('primaryLabel'));
    hrefField(grid, module, 'primaryHref', '主按钮链接', p('primaryHref'));
    textField(grid, module, 'secondaryLabel', '第二按钮文字', { max: 80 }, p('secondaryLabel'));
    hrefField(grid, module, 'secondaryHref', '第二按钮链接', p('secondaryHref'));
  } else {
    textField(grid, module, 'title', '模块标题', { wide: true, max: 300 }, p('title'));
    textField(grid, module, 'body', '模块正文', { wide: true, multiline: true, rows: module.type === 'custom' ? 7 : 4, max: module.type === 'custom' ? 5000 : 1200 }, p('body'));
    textField(grid, module, 'buttonLabel', '按钮文字', { max: 80 }, p('buttonLabel'));
    hrefField(grid, module, 'buttonHref', '按钮链接', p('buttonHref'));
  }
}
function renderHomeModules() {
  const wrap = $('homeModulesEditor');
  if (!wrap) return;
  wrap.replaceChildren();
  const modules = [...(state.config.homeModules || [])].sort((a, b) => Number(a.order) - Number(b.order));
  for (const module of modules) {
    const index = state.config.homeModules.indexOf(module);
    const base = ['homeModules', index];
    const card = node('article', 'module-editor');
    toggleRowDisabled(card, module.enabled);
    const head = node('div', 'module-head');
    const title = node('div', 'module-title');
    const titleText = node('div');
    titleText.append(node('strong', '', module.name || module.id), node('small', '', `${module.type} · ${module.id}`));
    title.append(titleText);
    const controls = node('div', 'module-controls');
    const enabled = attach(checkbox(module.enabled), module, 'enabled', Boolean);
    enabled.addEventListener('change', () => {
      toggleRowDisabled(card, enabled.checked);
      void autoPersistPath([...base, 'enabled'], '模块启停状态已自动保存并实时生效。');
    });
    const enabledLabel = node('label');
    enabledLabel.append(enabled, document.createTextNode('启用'));
    const orderInput = attach(input(module.order, 'number'), module, 'order', Number);
    controls.append(enabledLabel, savedLabel('顺序', orderInput, [...base, 'order']));
    if (module.type === 'custom') {
      controls.append(button('删除模块', async () => {
        state.config.homeModules = state.config.homeModules.filter((entry) => entry !== module);
        renderHomeModules();
        await persistPaths([['homeModules']], { success: '自定义模块已删除并实时生效。' });
      }, 'danger module-danger'));
    }
    head.append(title, controls);
    card.append(head);
    const grid = node('div', 'module-grid');
    renderHomeFields(grid, module, base);
    card.append(grid);
    wrap.append(card);
  }
}

function renderPageModule(pageKey, module, index) {
  const base = ['pages', pageKey, 'modules', index];
  const card = node('div', 'module-editor');
  toggleRowDisabled(card, module.enabled);
  const head = node('div', 'module-head');
  const title = node('div', 'module-title');
  title.append(node('strong', '', module.name), node('small', '', module.type === 'protected' ? `受保护功能 · ${module.id}` : `内容模块 · ${module.id}`));
  const controls = node('div', 'module-controls');
  const enabled = attach(checkbox(module.enabled), module, 'enabled', Boolean);
  enabled.addEventListener('change', () => {
    toggleRowDisabled(card, enabled.checked);
    void autoPersistPath([...base, 'enabled'], '页面模块启停状态已自动保存并实时生效。');
  });
  const enabledLabel = node('label');
  enabledLabel.append(enabled, document.createTextNode('启用'));
  controls.append(enabledLabel);
  if (module.lockedOrder) controls.append(node('small', '', '固定顺序'));
  else {
    const orderInput = attach(input(module.order, 'number'), module, 'order', Number);
    controls.append(savedLabel('顺序', orderInput, [...base, 'order']));
  }
  head.append(title, controls);
  card.append(head);
  if (module.type === 'protected') {
    card.append(node('p', 'muted', '内部 DOM、表单字段、业务按钮和 API 绑定受保护；CMS 不会修改这些节点。'));
  }
  if (module.type === 'callout') {
    const grid = node('div', 'module-grid');
    textField(grid, module, 'title', '标题', { wide: true, max: 300 }, [...base, 'title']);
    textField(grid, module, 'body', '说明', { wide: true, multiline: true, rows: 4, max: 1600 }, [...base, 'body']);
    textField(grid, module, 'buttonLabel', '按钮文字', { max: 80 }, [...base, 'buttonLabel']);
    hrefField(grid, module, 'buttonHref', '按钮链接', [...base, 'buttonHref']);
    card.append(grid);
  }
  return card;
}
function renderCurrentPage() {
  const wrap = $('pagesEditor');
  if (!wrap || !OPERATIONAL_VIEWS.includes(state.view)) return;
  wrap.replaceChildren();
  const key = state.view;
  const pageConfig = state.config.pages?.[key];
  if (!pageConfig) {
    wrap.append(node('div', 'module-empty', '当前页面没有可编辑配置。'));
    return;
  }
  $('pageViewTitle').textContent = `${pageConfig.name || key} · 页面配置`;
  $('pageViewDescription').textContent = '这里只加载当前页面的编辑项；字段保存、样式选择和模块开关都会直接同步到公开官网。';
  const card = node('article', 'module-editor');
  const head = node('div', 'module-head');
  const title = node('div', 'module-title');
  title.append(node('strong', '', pageConfig.name || key), node('small', '', `/${key}`));
  const preview = node('a', 'button-link', '预览 ↗');
  preview.href = `/${key}`;
  preview.target = '_blank';
  preview.rel = 'noopener noreferrer';
  head.append(title, preview);
  card.append(head);
  const grid = node('div', 'module-grid');
  textField(grid, pageConfig, 'browserTitle', '浏览器标题', { max: 160, rich: false }, ['pages', key, 'browserTitle']);
  textField(grid, pageConfig, 'description', 'SEO 描述', { multiline: true, rows: 3, max: 500, wide: true, rich: false }, ['pages', key, 'description']);
  textField(grid, pageConfig.hero, 'eyebrow', '顶部短标题', { max: 160 }, ['pages', key, 'hero', 'eyebrow']);
  textField(grid, pageConfig.hero, 'title', '页面主标题', { multiline: true, rows: 2, max: 300 }, ['pages', key, 'hero', 'title']);
  textField(grid, pageConfig.hero, 'body', '页面引导说明', { multiline: true, rows: 4, max: 2000, wide: true }, ['pages', key, 'hero', 'body']);
  card.append(grid);
  const modules = node('div', 'nested-items');
  (pageConfig.modules || []).forEach((module, index) => modules.append(renderPageModule(key, module, index)));
  card.append(modules);
  wrap.append(card);
}

function updateViewShell() {
  const activeView = state.view;
  document.querySelectorAll('#websiteViewTabs [data-cms-view]').forEach((link) => {
    const active = link.dataset.cmsView === activeView;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('websiteGlobalView').hidden = activeView !== 'global';
  $('websiteHomeView').hidden = activeView !== 'home';
  $('websitePageView').hidden = !OPERATIONAL_VIEWS.includes(activeView);
  $('websiteLegalView').hidden = activeView !== 'legal';
  const preview = $('websitePreview');
  if (preview) {
    preview.href = activeView === 'home' || activeView === 'global'
      ? '/'
      : activeView === 'legal'
        ? '/privacy'
        : `/${activeView}`;
  }
}
function renderCurrentView() {
  updateViewShell();
  if (!state.config) return;
  if (state.view === 'global') {
    $('siteBrandName').value = state.config.site.brandName || '';
    $('siteTitle').value = state.config.site.title || '';
    $('siteDescription').value = state.config.site.description || '';
    $('siteFooterText').value = state.config.site.footerText || '';
    installSiteFieldSaves();
    renderNavigation();
  } else if (state.view === 'home') {
    renderHomeModules();
  } else if (OPERATIONAL_VIEWS.includes(state.view)) {
    renderCurrentPage();
  }
  if ($('websiteUpdated')) $('websiteUpdated').textContent = localDate(state.updatedAt);
}
async function loadWebsite() {
  const data = await api('/admin/api/website');
  state.config = clone(data.config);
  state.persisted = clone(data.config);
  state.updatedAt = data.updatedAt;
  renderCurrentView();
}
async function authenticate() {
  try {
    await api('/admin/api/account/dashboard');
    $('login').hidden = true;
    $('app').hidden = false;
    $('logout').hidden = false;
    await loadWebsite();
  } catch (error) {
    if (error.status === 401) {
      $('app').hidden = true;
      $('login').hidden = false;
      $('logout').hidden = true;
    } else $('loginMessage').textContent = error.message;
  }
}

let resetArmedUntil = 0;
async function resetWebsite() {
  const reset = $('resetWebsite');
  if (Date.now() > resetArmedUntil) {
    resetArmedUntil = Date.now() + 5000;
    reset.textContent = '再次点击确认恢复';
    setTimeout(() => {
      if (Date.now() > resetArmedUntil) reset.textContent = '恢复默认';
    }, 5100);
    return;
  }
  resetArmedUntil = 0;
  reset.disabled = true;
  try {
    const data = await api('/admin/api/website/reset', { method: 'POST', body: '{}' });
    state.config = clone(data.config);
    state.persisted = clone(data.config);
    state.updatedAt = data.updatedAt;
    renderCurrentView();
    await verifyPublicPaths([['site'], ['navigation'], ['homeModules'], ['pages']]);
    message('官网已恢复默认配置，并已同步到公开站点。', 'good');
  } catch (error) {
    message(error.message, 'bad');
  } finally {
    reset.disabled = false;
    reset.textContent = '恢复默认';
  }
}
function installLegalStyleAutoPublish() {
  const timers = new WeakMap();
  const schedule = (target) => {
    if (state.view !== 'legal') return;
    const toolbar = target?.closest?.('#websiteLegalView .cms-style-toolbar');
    const field = toolbar?.closest('.cms-field');
    const save = field?.querySelector(':scope > .cms-field-footer .cms-field-save');
    if (!save || save.disabled) return;
    clearTimeout(timers.get(field));
    timers.set(field, setTimeout(() => {
      timers.delete(field);
      if (!save.disabled) save.click();
    }, target?.type === 'color' ? 420 : 80));
  };
  document.addEventListener('change', (event) => schedule(event.target));
  document.addEventListener('input', (event) => {
    if (event.target?.type === 'color') schedule(event.target);
  });
  document.addEventListener('click', (event) => {
    if (event.target?.closest?.('#websiteLegalView .cms-style-toggle')) schedule(event.target);
  });
}

$('loginButton').addEventListener('click', async () => {
  try {
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    $('loginMessage').textContent = '';
    await authenticate();
  } catch (error) {
    $('loginMessage').textContent = error.message;
  }
});
$('password').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('loginButton').click();
});
$('logout').addEventListener('click', async () => {
  await api('/admin/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  location.reload();
});
$('resetWebsite').addEventListener('click', () => void resetWebsite());
$('addNav').addEventListener('click', async () => {
  state.config.navigation ||= [];
  const index = state.config.navigation.length + 1;
  state.config.navigation.push({
    id: `nav-${Date.now().toString(36)}`,
    label: `链接 ${index}`,
    href: '/',
    enabled: true,
    order: index * 10,
  });
  renderNavigation();
  await persistPaths([['navigation']], { success: '导航已新增并实时生效。' });
});
$('addCustomModule').addEventListener('click', async () => {
  state.config.homeModules ||= [];
  state.config.homeModules.push({
    id: `custom-${Date.now().toString(36)}`,
    type: 'custom',
    name: '自定义内容',
    enabled: true,
    order: (state.config.homeModules.length + 1) * 10,
    title: '新的内容模块',
    body: '填写需要展示的内容。',
    buttonLabel: '',
    buttonHref: '/',
  });
  renderHomeModules();
  await persistPaths([['homeModules']], { success: '自定义模块已新增并实时生效。' });
});
installLegalStyleAutoPublish();
updateViewShell();
void authenticate();
