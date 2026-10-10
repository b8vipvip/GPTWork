// Regression: an id-less lifecycle callback between Picker A model turns
// must never become a formal request-authority error.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const start = source.indexOf('  onRewrite(tabId, rewrite) {');
const end = source.indexOf('  onRequest(tabId, request) {', start);
assert.ok(start > 0 && end > start, 'network onRewrite callback missing');
const callback = source.slice(start, end).trim().replace(/},\s*$/, '}');

function run(rewrite) {
  const state = { phase: 'waiting', lastError: null };
  const events = [];
  const runtime = {
    ensureTabState: () => state,
    verificationTransactionForTab: () => ({ model: 'gpt-5.6-sol' }),
    logRuntime: (_level, _component, event) => events.push(event),
    broadcastTabState: async () => {},
  };
  vm.createContext(runtime);
  const handler = vm.runInContext('({' + callback + '}).onRewrite', runtime);
  handler(123, rewrite);
  return { state, events };
}

test('an id-less callback while changing Picker A tasks cannot report a false request mismatch', () => {
  const { state, events } = run({
    endpoint: '/backend-api/f/conversation',
    fetchRequestId: null,
    requestId: null,
    authorityKind: null,
    changed: false,
  });
  assert.equal(state.phase, 'waiting');
  assert.equal(state.lastError, null);
  assert.equal(events.includes('verification_request_generation_or_authority_mismatch'), false);
});

test('actual formal Chat Fetch without terminal discovery authority still fails closed', () => {
  const { state, events } = run({
    endpoint: '/backend-api/f/conversation',
    fetchRequestId: 'interception-job-57',
    requestId: null,
    authorityKind: null,
    changed: false,
  });
  assert.equal(state.phase, 'error');
  assert.equal(state.lastError, 'verification_request_missing_terminal_authority');
  assert.equal(events.includes('verification_request_generation_or_authority_mismatch'), true);
});

test('an unrelated Fetch lifecycle event is not a formal Chat model request', () => {
  const { state, events } = run({
    endpoint: '/backend-api/models',
    fetchRequestId: 'interception-job-77',
    changed: false,
  });
  assert.equal(state.phase, 'waiting');
  assert.equal(events.includes('verification_request_generation_or_authority_mismatch'), false);
});

test('a valid Picker A discovery Fetch retains its request-scoped authority', () => {
  const { state, events } = run({
    endpoint: '/backend-api/f/conversation',
    fetchRequestId: 'interception-job-88',
    requestId: 'network-13',
    authorityKind: 'model-discovery-picker-a-ui-lock',
    authorityModel: 'gpt-5.5',
    modelAfter: 'gpt-5.5',
    transportModelAfter: 'gpt-5.5-thinking',
    changed: false,
  });
  assert.equal(state.phase, 'waiting');
  assert.equal(events.includes('verification_request_generation_or_authority_mismatch'), false);
  assert.equal(state.lastForwardedRequest.requestId, 'network-13');
  assert.equal(state.lastForwardedRequest.transportModel, 'gpt-5.5-thinking');
});
