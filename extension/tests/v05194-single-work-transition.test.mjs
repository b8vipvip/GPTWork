// [legacy-core-maintenance] v0.5.194 field regression: first CDP Work click
// navigates the SPA, loses its content message response, and MUST NOT be clicked twice.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [background, content] = await Promise.all([
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
  readFile(new URL('../content.js', import.meta.url), 'utf8'),
]);

const namedBlock = (source, a, b) => {
  const start = source.indexOf(a);
  const end = source.indexOf(b, start + a.length);
  assert.ok(start >= 0 && end > start, 'missing named block: ' + a);
  return source.slice(start, end);
};

test('Work mode performs exactly one command if the first click loses its reply during navigation', async () => {
  const source = namedBlock(background, 'async function enterNativeWorkOnDiscoveryTab', 'function successfulConversationResponseEvidence');
  let messages = 0;
  let readyChecks = 0;
  const runtime = {
    waitForVerificationSurface: async () => { readyChecks++; return { ready: true }; },
    sendTabMessage: async () => {
      messages++;
      throw new Error('message port closed after Work navigation');
    },
    logRuntime: () => {},
    errorText: (error) => String(error),
  };
  vm.createContext(runtime);
  const enter = vm.runInContext(source + '\nenterNativeWorkOnDiscoveryTab', runtime);
  const result = await enter(42, 9000);
  assert.equal(readyChecks, 1);
  assert.equal(messages, 1);
  assert.equal(result.entered, false);
  assert.equal(result.actuated, false);
  assert.equal(result.pendingModeConfirmation, true);
  assert.equal(result.reason, 'work_transition_reply_lost');
});

test('a page with no ready composer never receives the Work command', async () => {
  const source = namedBlock(background, 'async function enterNativeWorkOnDiscoveryTab', 'function successfulConversationResponseEvidence');
  let messages = 0;
  const runtime = {
    waitForVerificationSurface: async () => ({ ready: false, reason: 'composer_not_ready' }),
    sendTabMessage: async () => { messages++; },
  };
  vm.createContext(runtime);
  const enter = vm.runInContext(source + '\nenterNativeWorkOnDiscoveryTab', runtime);
  const result = await enter(42, 9000);
  assert.equal(messages, 0);
  assert.equal(result.pendingModeConfirmation, false);
  assert.equal(result.reason, 'composer_not_ready');
});

test('Work can only be confirmed by the existing Picker B owner after ambiguous actuation', () => {
  const source = namedBlock(background, 'async function discoverOfficialWorkModels', 'async function publishAccountModels');
  assert.match(source, /enter\?\.pendingModeConfirmation !== true/);
  assert.match(source, /discovered\?\.pickerMode === 'B'/);
  assert.match(source, /official_work_surface_confirmed_by_picker_b/);
  assert.match(source, /work_surface_not_confirmed_by_picker_b/);
  assert.doesNotMatch(source, /official_work_model_discovery_activation_fallback/);
});

test('null Chat picker does not veto mode before the same classifier has time to settle', async () => {
  const source = namedBlock(content, 'async function readVerificationOfficialMode()', 'async function verifyOfficialChatMode(');
  let reads=0, closed=0;
  const runtime = {
    Date,
    location: { pathname: '/' },
    window: { setTimeout: (fn) => fn() },
    openModernModelMenu: async () => (++reads === 1
      ? { pickerMode: null, rows: [], trigger: null }
      : { pickerMode: 'A', rows: ['5.5','5.6','6'], trigger: {} }),
    closeModelMenus: async () => { closed++; },
  };
  vm.createContext(runtime);
  const read = vm.runInContext(source + '\nreadVerificationOfficialMode', runtime);
  const result = await read();
  assert.equal(reads, 2);
  assert.equal(closed, 2);
  assert.equal(result.pickerMode, 'A');
  assert.equal(result.modelCount, 3);
  assert.match(source, /const picker = await openModernModelMenu\(\)/);
  assert.doesNotMatch(source, /verificationWorkSurfaceEvidence/);
});
