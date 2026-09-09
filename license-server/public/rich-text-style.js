const FONT_OPTIONS = [
  ['', '默认字体'],
  ['system', '系统字体'],
  ['sans', '无衬线'],
  ['serif', '衬线'],
  ['mono', '等宽'],
  ['yahei', '微软雅黑'],
  ['pingfang', '苹方'],
  ['arial', 'Arial'],
  ['georgia', 'Georgia'],
];
const FONT_STACKS = {
  system: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  sans: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  yahei: '"Microsoft YaHei", "PingFang SC", sans-serif',
  pingfang: '"PingFang SC", "Microsoft YaHei", sans-serif',
  arial: 'Arial, Helvetica, sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
};
const SIZE_VALUES = [12,14,16,18,20,24,28,32,40,48,56,64,72];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const STYLE_PROPS = ['font-family','font-size','color','background-color','font-weight','font-style','text-decoration-line'];

function safeColor(value) {
  const text = String(value || '').trim();
  return COLOR_RE.test(text) ? text.toLowerCase() : '';
}
export function normalizeTextStyle(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const output = {};
  const font = String(source.font || '').trim().toLowerCase();
  const size = Number(source.size || 0);
  const color = safeColor(source.color);
  const background = safeColor(source.background);
  if (Object.hasOwn(FONT_STACKS, font)) output.font = font;
  if (SIZE_VALUES.includes(size)) output.size = size;
  if (color) output.color = color;
  if (background) output.background = background;
  if (source.bold === true) output.bold = true;
  if (source.italic === true) output.italic = true;
  if (source.underline === true) output.underline = true;
  return output;
}
export function applyTextStyle(target, input = {}) {
  if (!target) return;
  const style = normalizeTextStyle(input);
  for (const property of STYLE_PROPS) target.style.removeProperty(property);
  if (style.font) target.style.fontFamily = FONT_STACKS[style.font];
  if (style.size) target.style.fontSize = `${style.size}px`;
  if (style.color) target.style.color = style.color;
  if (style.background) target.style.backgroundColor = style.background;
  if (style.bold) target.style.fontWeight = '800';
  if (style.italic) target.style.fontStyle = 'italic';
  if (style.underline) target.style.textDecorationLine = 'underline';
}
function option(value, label) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = label;
  return item;
}
function smallButton(label, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cms-style-toggle';
  button.textContent = label;
  button.title = title;
  return button;
}
export function createTextStyleToolbar({ control, value = {}, onChange } = {}) {
  let current = normalizeTextStyle(value);
  const bar = document.createElement('span');
  bar.className = 'cms-style-toolbar';
  bar.setAttribute('aria-label', '文本样式编辑器');
  const font = document.createElement('select');
  font.className = 'cms-style-select cms-style-font';
  font.title = '字体';
  for (const [key, label] of FONT_OPTIONS) font.append(option(key, label));
  font.value = current.font || '';
  const size = document.createElement('select');
  size.className = 'cms-style-select cms-style-size';
  size.title = '字号';
  size.append(option('', '默认字号'));
  for (const value of SIZE_VALUES) size.append(option(String(value), `${value}px`));
  size.value = current.size ? String(current.size) : '';
  const bold = smallButton('B', '加粗');
  const italic = smallButton('I', '斜体');
  const underline = smallButton('U', '下划线');
  const colorLabel = document.createElement('label');
  colorLabel.className = 'cms-style-color';
  colorLabel.title = '文字颜色';
  colorLabel.append(document.createTextNode('字'));
  const color = document.createElement('input');
  color.type = 'color';
  color.value = current.color || '#17201d';
  color.setAttribute('aria-label', '文字颜色');
  colorLabel.append(color);
  const clearColor = smallButton('×', '恢复默认文字颜色');
  const bgLabel = document.createElement('label');
  bgLabel.className = 'cms-style-color';
  bgLabel.title = '背景色';
  bgLabel.append(document.createTextNode('底'));
  const background = document.createElement('input');
  background.type = 'color';
  background.value = current.background || '#ffffff';
  background.setAttribute('aria-label', '背景色');
  bgLabel.append(background);
  const clearBackground = smallButton('×', '清除背景色');
  const reset = smallButton('清除格式', '恢复该字段默认样式');

  const sync = () => {
    bold.classList.toggle('active', Boolean(current.bold));
    italic.classList.toggle('active', Boolean(current.italic));
    underline.classList.toggle('active', Boolean(current.underline));
    font.value = current.font || '';
    size.value = current.size ? String(current.size) : '';
    color.value = current.color || '#17201d';
    background.value = current.background || '#ffffff';
    applyTextStyle(control, current);
  };
  const change = (patch) => {
    current = normalizeTextStyle({ ...current, ...patch });
    sync();
    onChange?.({ ...current });
  };
  font.addEventListener('change', () => change({ font: font.value || undefined }));
  size.addEventListener('change', () => change({ size: size.value ? Number(size.value) : undefined }));
  bold.addEventListener('click', () => change({ bold: !current.bold }));
  italic.addEventListener('click', () => change({ italic: !current.italic }));
  underline.addEventListener('click', () => change({ underline: !current.underline }));
  color.addEventListener('input', () => change({ color: color.value }));
  background.addEventListener('input', () => change({ background: background.value }));
  clearColor.addEventListener('click', () => {
    const next = { ...current };
    delete next.color;
    current = normalizeTextStyle(next);
    sync();
    onChange?.({ ...current });
  });
  clearBackground.addEventListener('click', () => {
    const next = { ...current };
    delete next.background;
    current = normalizeTextStyle(next);
    sync();
    onChange?.({ ...current });
  });
  reset.addEventListener('click', () => {
    current = {};
    sync();
    onChange?.({});
  });
  bar.append(font, size, bold, italic, underline, colorLabel, clearColor, bgLabel, clearBackground, reset);
  sync();
  return bar;
}

function installPublicCmsLiveReload() {
  if (typeof document === 'undefined' || document.body?.dataset?.adminPage) return;
  let websiteStamp = null;
  let legalVersion = null;
  let running = false;
  const legalKey = String(document.body?.dataset?.legalKey || '').trim();

  async function check() {
    if (running || document.hidden) return;
    running = true;
    try {
      if (legalKey) {
        const response = await fetch(`/site/api/legal/${encodeURIComponent(legalKey)}?_=${Date.now()}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => null);
        const nextVersion = Number(data?.version || 0);
        if (legalVersion === null) legalVersion = nextVersion;
        else if (nextVersion && nextVersion !== legalVersion) location.reload();
        return;
      }
      const response = await fetch(`/site/api/website?_=${Date.now()}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) return;
      const data = await response.json().catch(() => null);
      const nextStamp = String(data?.updatedAt || '');
      if (websiteStamp === null) websiteStamp = nextStamp;
      else if (nextStamp && nextStamp !== websiteStamp) location.reload();
    } catch {
      // The regular page loader keeps the site usable if a background sync check fails.
    } finally {
      running = false;
    }
  }

  void check();
  const timer = setInterval(() => void check(), 3000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void check();
  });
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}

function guideAdminStyle() {
  if (document.getElementById('gptwork-guide-editor-style')) return;
  const style = document.createElement('style');
  style.id = 'gptwork-guide-editor-style';
  style.textContent = `
    .guide-step-editor-list{display:grid;gap:14px;margin-top:14px}
    .guide-step-editor-row{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr) 118px;gap:18px;align-items:start;padding:16px;border:1px solid #dbe3ef;border-radius:14px;background:#fbfdff}
    .guide-step-title-field,.guide-step-body-field{display:flex!important;flex-direction:column;gap:7px;min-width:0;margin:0!important}
    .guide-step-title-field input{width:100%!important;max-width:300px!important;min-height:42px}
    .guide-step-body-field textarea{width:100%!important;min-height:156px!important;resize:vertical;line-height:1.65;padding:12px 13px}
    .guide-step-body-field .cms-style-toolbar{margin:0 0 2px;width:100%;box-sizing:border-box}
    .guide-step-actions{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-end;gap:8px;min-height:206px;padding-top:26px}
    .guide-step-actions .cms-field-save{width:100%;min-height:40px!important}
    .guide-step-actions .cms-field-status{max-width:none;white-space:normal;text-align:center;line-height:1.45}
    .guide-step-number{display:inline-flex;align-items:center;justify-content:center;width:34px;height:24px;margin-right:7px;border-radius:999px;background:#17201d;color:#fff;font-size:11px;font-weight:800;vertical-align:middle}
    .guide-step-editor-note{margin:10px 0 0;color:#64748b;font-size:12px;line-height:1.55}
    @media(max-width:1100px){.guide-step-editor-row{grid-template-columns:minmax(190px,260px) minmax(0,1fr)}.guide-step-actions{grid-column:1/-1;min-height:0;padding-top:0;flex-direction:row;align-items:center;justify-content:flex-end}.guide-step-actions .cms-field-save{width:auto;min-width:92px}.guide-step-actions .cms-field-status{text-align:right}}
    @media(max-width:760px){.guide-step-editor-row{grid-template-columns:1fr}.guide-step-title-field input{max-width:none!important}.guide-step-actions{grid-column:auto;justify-content:flex-start}.guide-step-actions .cms-field-status{text-align:left}.guide-step-body-field .cms-style-toolbar{overflow-x:auto;flex-wrap:nowrap}.guide-step-body-field .cms-style-toolbar>*{flex:0 0 auto}}
  `;
  document.head.append(style);
}

async function guideAdminApi(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body;
}

function guideAdminNode(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function installGuideStepsAdminEnhancer() {
  if (typeof document === 'undefined' || document.body?.dataset?.adminPage !== 'website') return;
  if (new URLSearchParams(location.search).get('view') !== 'guide') return;
  guideAdminStyle();
  const host = document.getElementById('pagesEditor');
  if (!host) return;

  let mounting = false;
  const mount = async () => {
    if (mounting) return false;
    const card = [...host.querySelectorAll('.module-editor')].find((entry) => entry.querySelector('.module-title small')?.textContent?.includes('guide-steps'));
    if (!card || card.dataset.guideStepEnhanced === '1' || card.dataset.guideStepEditor !== '1') return false;
    mounting = true;
    try {
      const data = await guideAdminApi('/admin/api/website');
      const module = data.config?.pages?.guide?.modules?.find((entry) => entry.id === 'guide-steps');
      if (!module || !Array.isArray(module.items)) return false;

      const oldWrap = card.querySelector('.nested-items');
      if (!oldWrap) return false;
      const wrap = guideAdminNode('div', 'guide-step-editor-list');
      module.items.forEach((item, index) => {
        const row = guideAdminNode('div', 'guide-step-editor-row');
        row.dataset.guideStepIndex = String(index);

        const titleLabel = guideAdminNode('label', 'guide-step-title-field');
        const titleCaption = guideAdminNode('span', 'cms-field-label');
        titleCaption.append(guideAdminNode('span', 'guide-step-number', String(index + 1).padStart(2, '0')), document.createTextNode('步骤标题'));
        const titleInput = document.createElement('input');
        titleInput.maxLength = 160;
        titleInput.value = item.title || '';
        titleInput.setAttribute('aria-label', `步骤 ${index + 1} 标题`);
        titleLabel.append(titleCaption, titleInput);

        const bodyLabel = guideAdminNode('label', 'guide-step-body-field');
        bodyLabel.append(guideAdminNode('span', 'cms-field-label', '步骤说明'));
        const bodyInput = document.createElement('textarea');
        bodyInput.rows = 6;
        bodyInput.maxLength = 1200;
        bodyInput.value = item.body || '';
        bodyInput.setAttribute('aria-label', `步骤 ${index + 1} 说明`);
        let bodyStyle = normalizeTextStyle(item.styles?.body || {});
        const toolbar = createTextStyleToolbar({
          control: bodyInput,
          value: bodyStyle,
          onChange: (next) => {
            bodyStyle = normalizeTextStyle(next);
            status.textContent = '样式已修改，点击保存';
          },
        });
        bodyLabel.append(toolbar, bodyInput);

        const actions = guideAdminNode('div', 'guide-step-actions');
        const status = guideAdminNode('small', 'cms-field-status');
        const save = guideAdminNode('button', 'cms-field-save', '保存');
        save.type = 'button';
        save.addEventListener('click', async () => {
          const original = save.textContent;
          save.disabled = true;
          save.textContent = '保存中…';
          status.textContent = '正在保存';
          try {
            const latest = await guideAdminApi('/admin/api/website');
            const guideModule = latest.config?.pages?.guide?.modules?.find((entry) => entry.id === 'guide-steps');
            if (!guideModule?.items?.[index]) throw new Error('教程步骤配置不存在，请刷新页面重试');
            const target = guideModule.items[index];
            target.title = titleInput.value;
            target.body = bodyInput.value;
            target.styles = { ...(target.styles || {}), body: bodyStyle };
            const saved = await guideAdminApi('/admin/api/website', { method: 'PUT', body: JSON.stringify({ config: latest.config }) });
            const savedItem = saved.config?.pages?.guide?.modules?.find((entry) => entry.id === 'guide-steps')?.items?.[index];
            if (!savedItem) throw new Error('保存后未读取到教程步骤');
            titleInput.value = savedItem.title || '';
            bodyInput.value = savedItem.body || '';
            bodyStyle = normalizeTextStyle(savedItem.styles?.body || {});
            applyTextStyle(bodyInput, bodyStyle);
            status.textContent = '已保存并同步官网';
            const globalMessage = document.getElementById('websiteMessage');
            if (globalMessage) {
              globalMessage.textContent = `教程步骤 ${index + 1} 已保存并实时生效。`;
              globalMessage.className = 'message good';
            }
          } catch (error) {
            status.textContent = '保存失败';
            const globalMessage = document.getElementById('websiteMessage');
            if (globalMessage) {
              globalMessage.textContent = error.message;
              globalMessage.className = 'message bad';
            }
          } finally {
            save.disabled = false;
            save.textContent = original;
          }
        });
        actions.append(status, save);
        row.append(titleLabel, bodyLabel, actions);
        wrap.append(row);
      });
      oldWrap.replaceWith(wrap);
      card.dataset.guideStepEnhanced = '1';
      const intro = [...card.children].find((entry) => entry.classList?.contains('muted'));
      if (intro) intro.textContent = '教程步骤编号与页面结构由系统保护；标题保持紧凑编辑，步骤说明使用更大的编辑区，并支持字体、字号、加粗、斜体、下划线和颜色等简易格式。';
      const note = guideAdminNode('p', 'guide-step-editor-note', '格式只作用于对应步骤说明；修改文字或格式后点击该步骤右侧“保存”，即可实时同步到官网。');
      wrap.before(note);
      return true;
    } catch {
      return false;
    } finally {
      mounting = false;
    }
  };

  void mount();
  const observer = new MutationObserver(() => {
    void mount().then((done) => { if (done) observer.disconnect(); });
  });
  observer.observe(host, { childList: true, subtree: true });
}

installPublicCmsLiveReload();
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installGuideStepsAdminEnhancer, { once: true });
  else installGuideStepsAdminEnhancer();
}
