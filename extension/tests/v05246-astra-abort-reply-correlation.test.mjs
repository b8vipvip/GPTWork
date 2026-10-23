import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import {
  astraDebugObservationComplete, astraDebugVerdict, publicAstraDebugProbe,
  ASTRA_DEBUG_TRANSPORT,
} from '../astra-debug-probe.js';

const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

function observeRoute(paths, responseAppearsAfter = 3) {
  const first = content.indexOf('  async function waitForDebugAstraReply(options = {}) {');
  const end = content.indexOf('  async function autoSendProbe(options = {}) {', first);
  assert.ok(first >= 0 && end > first);
  let clock = 1000;
  let step = 0;
  const location = { pathname: paths[0], href: 'https://chatgpt.com' + paths[0] };
  const ctx = vm.createContext({
    location,
    Date: { now() { return clock; } },
    assistantMessages() { return step >= responseAppearsAfter ? [{ innerText: '156' }] : []; },
    visibleGeneratingControl() { return false; },
    window: {
      setTimeout(resolve) {
        step += 1;
        clock += 1000;
        const path = paths[Math.min(step, paths.length - 1)];
        location.pathname = path;
        location.href = 'https://chatgpt.com' + path;
        resolve();
      },
    },
  });
  vm.runInContext(content.slice(first, end) + '\nglobalThis.observe = waitForDebugAstraReply;', ctx);
  return ctx.observe({ assistantCountBefore: 0, timeoutMs: 15000 });
}

test('home, local placeholder, home bounce and finalized conversation keep same reply observer', async () => {
  const result = await observeRoute([
    '/', '/c/local-chatgpt', '/', '/c/real-conversation/', '/c/real-conversation/',
    '/c/real-conversation/', '/c/real-conversation/',
  ], 4);
  assert.equal(result.settled, true);
  assert.equal(result.responseTextSnippet, '156');
  assert.equal(result.navigationCount, 3);
  assert.equal(result.navigation, 'new_chat->conversation');
});

test('navigation between unrelated real conversations is rejected without exposing IDs', async () => {
  const result = await observeRoute(['/', '/c/conversation-one', '/c/conversation-two'], 100);
  assert.equal(result.settled, false);
  assert.equal(result.reason, 'conversation_navigated');
  assert.equal(result.navigation, 'conversation->conversation');
  assert.equal(result.navigationCount, 2);
  assert.equal(JSON.stringify(result).includes('conversation-one'), false);
});

test('aborted 200/SSE response keeps failed outcome while independent reply witness completes', () => {
  const probe = {
    forwardedTransportModel: ASTRA_DEBUG_TRANSPORT,
    httpStatus: 200, terminalEvent: 'conversation_response_failed',
    networkError: 'net::ERR_ABORTED', sseTerminalObserved: true,
    responseModel: 'gpt-6', responseDefaultModel: 'gpt-6-astra',
    responseEvidenceSettled: true, assistantObservationComplete: false,
  };
  assert.equal(astraDebugObservationComplete(probe), false);
  assert.equal(astraDebugObservationComplete({ ...probe, assistantObservationComplete: true }), true);
  assert.equal(astraDebugObservationComplete({ ...probe, responseEvidenceSettled: false,
    assistantObservationComplete: true }), false);
  assert.equal(astraDebugVerdict({ ...probe, assistantSettled: true }).requestOutcome, 'failed');
  assert.equal(astraDebugVerdict({ ...probe, assistantSettled: true }).modelVerdict, 'unverified');
});

test('debug lifecycle retains network and page ownership until both observations conclude', () => {
  assert.match(background, /function finalizeDebugAstraObservation\(tabId\)/);
  assert.match(background, /astraDebugObservationComplete\(probe\)/);
  assert.match(background, /assistantObservationComplete: true/);
  assert.match(background, /responseEvidenceSettled: true/);
  assert.match(background, /finalizeDebugAstraObservation\(tabId\);/);
  assert.match(background, /protocol\?\.downstream !== true/);
  assert.match(background, /astra_debug_page_navigation_observed/);
  const protocol = background.split('  onProtocolEvent(tabId, protocol) {')[1]
    ?.split('  onOriginTrace(tabId, trace) {')[0];
  assert.ok(protocol);
  assert.doesNotMatch(protocol, /void endDebugAstra\(tabId\)/);
});

test('public probe exports route categories but not raw page URL or conversation identifiers', () => {
  const result = publicAstraDebugProbe({
    pageNavigationEvents: ['route_changed:placeholder', 'route_changed:conversation'],
    assistantNavigation: 'placeholder->conversation', assistantNavigationCount: 2,
    networkCanceled: true, transportElapsedMs: 4183,
    url: 'https://chatgpt.com/c/private-identifier',
    rawResponseBody: 'PRIVATE',
  });
  assert.equal(result.networkCanceled, true);
  assert.equal(result.transportElapsedMs, 4183);
  assert.deepEqual(result.pageNavigationEvents, ['route_changed:placeholder', 'route_changed:conversation']);
  assert.equal(JSON.stringify(result).includes('private-identifier'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
