// [legacy-core-maintenance] v0.5.193 regression from the v0.5.192 Work-send trace.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [content, background] = await Promise.all([
  readFile(new URL('../content.js', import.meta.url), 'utf8'),
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
]);

function extract(source, begin, end) {
  const first = source.indexOf(begin);
  const last = source.indexOf(end, first + begin.length);
  assert.ok(first >= 0 && last > first, "Missing source block: " + begin);
  return source.slice(first, last);
}

test('the sole trusted pointer authority accepts a button whose center hit is its SVG path', async () => {
  const pointHelpers = extract(
    content, 'function pointerStillOwnsPoint(element, point)',
    "  // ChatGPT's 2026-09 ViewTrack",
  );
  const pointerSource = extract(
    content, "async function trustedPointer(element, action = 'click'",
    '  function visibleIntelligencePickerContent()',
  );

  const dispatched = [];
  let currentHit = null;
  const runtime = {
    window: { innerWidth: 1600, innerHeight: 900 },
    document: { elementFromPoint: () => currentHit },
    visible: (element) => element.isConnected,
    pointerTrace: () => {},
    compactElementProbe: (element) => element ? { tag: element.tag } : null,
    activeComposerSurface: () => null,
    waitUntil: async (probe) => probe(), // one timer opportunity: background-tab throttling
    sendMessage: async (message) => { dispatched.push(message); return { ok: true }; },
    errorText: (error) => String(error),
  };
  const button = {
    tag: 'button',
    isConnected: true,
    scrollIntoView() {},
    focus() {},
    getBoundingClientRect: () => ({ left: 1258, right: 1294, top: 395, bottom: 431 }),
    contains(node) { return node === currentHit && node.parentElement === button; },
  };
  const svg = { tag: 'svg', parentElement: button };
  const path = { tag: 'path', parentElement: button };
  button.contains = (node) => node === svg || node === path;
  currentHit = path;
  vm.createContext(runtime);
  const click = vm.runInContext(
    'let pointerTraceSeq = 0;\n' + pointHelpers + '\n' + pointerSource + '\ntrustedPointer;',
    runtime,
  );
  assert.equal(await click(button, 'click', 'auto-probe-send'), true);
  assert.equal(dispatched.filter((msg) => msg.type === 'GPTLOCK_TRUSTED_POINTER').length, 1);

  dispatched.length = 0;
  currentHit = { tag: 'button', parentElement: null }; // an occluding, unrelated control
  assert.equal(await click(button, 'click', 'auto-probe-send'), false);
  assert.equal(dispatched.filter((msg) => msg.type === 'GPTLOCK_TRUSTED_POINTER').length, 0);
});

test('trustedPointer does not require three timer frames for a valid owned click', () => {
  const pointerSource = extract(content,
    "async function trustedPointer(element, action = 'click'",
    '  function visibleIntelligencePickerContent()');
  assert.match(pointerSource, /const ready = await waitUntil/);
  assert.match(pointerSource, /pointerOwnedVisiblePoint\(element\)/);
  assert.match(pointerSource, /pointerStillOwnsPoint\(element, point\)/);
  assert.doesNotMatch(pointerSource, /stableFrames|previousPoint|rejected_unstable_hit_test/);
});

test('official Work discovery owns the foreground from creation until it restores the shared Chat tab', () => {
  const source = extract(background, 'async function discoverOfficialWorkModels(',
    'async function publishAccountModels(');
  assert.match(source, /url: 'https:\/\/chatgpt\.com\/',\s*active: true/);
  assert.match(source, /official_work_model_discovery_tab_created/);
  assert.match(source, /await chrome\.tabs\.update\(sourceTabId, \{ active: true \}\)/);
  assert.doesNotMatch(source, /official_work_model_discovery_activation_fallback/);
  assert.doesNotMatch(source, /activatedForReadiness/);
  assert.equal((source.match(/enterNativeWorkOnDiscoveryTab\(discoveryTabId,/g) || []).length, 1);
});

test('no other send candidate is substituted for the owned ChatGPT composer control', () => {
  const autoSend = extract(content, 'async function autoSendProbe(options = {})',
    'function assistantMessages()');
  assert.match(autoSend, /trustedPointer\(sendButton, 'click', 'auto-probe-send'\)/);
  assert.match(autoSend, /if \(!clicked\)/);
  assert.match(autoSend, /const sent = await waitUntil/);
  assert.match(autoSend, /Visible test message was not accepted by ChatGPT/);
});
