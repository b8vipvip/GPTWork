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

installPublicCmsLiveReload();
