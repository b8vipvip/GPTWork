import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const surfaceSource = await read('composer-surface.js');

function fakeElement({ tag = 'DIV', contenteditable = null, label = '', hidden = false } = {}) {
  const attrs = {
    ...(contenteditable === null ? {} : { contenteditable }),
    ...(label ? { 'aria-label': label } : {}),
  };
  return {
    tagName: tag,
    type: tag === 'INPUT' ? 'text' : undefined,
    disabled: false, readOnly: false, isConnected: true,
    getAttribute(name) { return attrs[name] ?? null; },
    closest(selector) { return hidden && selector.includes('aside,nav') ? {} : null; },
    getBoundingClientRect() { return { width: 600, height: 52, top: 400, bottom: 452, left: 200, right: 800 }; },
  };
}
function harness({ mainEditors = [], primary = [], unrelated = [] } = {}) {
  const form = fakeElement();
  const main = fakeElement();
  form.querySelectorAll = () => mainEditors;
  main.querySelectorAll = () => mainEditors;
  const editors = [...mainEditors, ...unrelated];
  const document = {
    readyState: 'complete', visibilityState: 'visible',
    querySelectorAll(selector) {
      if (selector === 'main form, form[data-testid*="composer"],main [data-testid*="composer"]') return [form];
      if (selector === 'main form') return [form];
      if (selector === 'textarea,[contenteditable],[role="textbox"],input[type="text"]') return editors;
      if (selector === '#prompt-textarea') return primary;
      return [];
    },
    querySelector(selector) { return selector === 'main' ? main : null; },
  };
  const sandbox = { document, window: { innerHeight: 1000, innerWidth: 1600 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  vm.runInNewContext(surfaceSource, sandbox);
  return sandbox.GPTWorkComposerSurfaceV1;
}

test('new single contenteditable=plaintext-only chat editor is found without older selectors', () => {
  const editor = fakeElement({ contenteditable: 'plaintext-only' });
  const surface = harness({ mainEditors: [editor] });
  assert.equal(surface.getActiveComposer(), editor);
  assert.equal(surface.diagnosticSnapshot().mainForms, 1);
  assert.equal(surface.diagnosticSnapshot().visibleEditable, 1);
});

test('visible sidebar/search field cannot steal the active main-form composer', () => {
  const editor = fakeElement({ contenteditable: 'true' });
  const sidebar = fakeElement({ tag: 'INPUT', label: 'Search' });
  const surface = harness({ mainEditors: [editor], unrelated: [sidebar] });
  assert.equal(surface.getActiveComposer(), editor);
});

test('ambiguous main form cannot auto-fill arbitrary fields', () => {
  const first = fakeElement({ contenteditable: 'true' });
  const second = fakeElement({ contenteditable: 'true' });
  assert.equal(harness({ mainEditors: [first, second] }).getActiveComposer(), null);
  const chat = fakeElement({ contenteditable: 'true', label: '询问 ChatGPT' });
  assert.equal(harness({ mainEditors: [first, chat] }).getActiveComposer(), chat);
});

test('hidden or non-editable fields are ignored', () => {
  const hidden = fakeElement({ contenteditable: 'true', hidden: true });
  const noneditable = fakeElement({ contenteditable: 'false' });
  assert.equal(harness({ mainEditors: [hidden, noneditable] }).getActiveComposer(), null);
});

test('one shared composer surface is loaded before send compatibility and content', async () => {
  const [manifestText, content, compat, background, html, ui] = await Promise.all([
    read('manifest.json'), read('content.js'), read('composer-send-compat.js'),
    read('background.js'), read('debug-tools.html'), read('debug-tools.js'),
  ]);
  const manifest = JSON.parse(manifestText);
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf('composer-surface.js') < scripts.indexOf('composer-send-compat.js'));
  assert.ok(scripts.indexOf('composer-surface.js') < scripts.indexOf('content.js'));
  assert.match(content, /globalThis\.GPTWorkComposerSurfaceV1/);
  assert.match(compat, /globalThis\.GPTWorkComposerSurfaceV1/);
  assert.match(content, /visibleEditable/);
  assert.match(background, /tabIndex: Number\.isInteger\(tab\.index\)/);
  assert.match(background, /title: String\(tab\.title/);
  assert.match(ui, /chrome\.tabs\.update\(tabId, \{ active: true \}\)/);
  assert.match(ui, /chrome\.windows\.update\(tab\.windowId, \{ focused: true \}\)/);
  assert.match(html, /id="locateTab"/);
  assert.match(html, /id="targetTabInfo"/);
  assert.equal(manifest.version, '0.5.245');
});
