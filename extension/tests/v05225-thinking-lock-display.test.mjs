import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [catalog, historyCode] = await Promise.all([
  readFile(new URL('../model-catalog.js', import.meta.url), 'utf8'),
  readFile(new URL('../model-status-history.js', import.meta.url), 'utf8'),
]);
const start = catalog.indexOf('  function modelSnapshot(state) {');
const end = catalog.indexOf('\n  function rememberModels(candidates) {', start);
assert.ok(start > 0 && end > start);

function snapshot(state, lockedModels = ['gpt-6', 'gpt-5.6-sol']) {
  const env = vm.createContext({
    currentPolicy: { lockedModels },
    trustedStatus: null,
    normalizeModelId(value) { return value || null; },
    normalizeConcreteModelId(value) { return value || null; },
    modelLabel(value) { return value; },
    effectivePageObservation(value) { return value?.pageObservation ?? null; },
    timestamp(value) { const x = Date.parse(value || ''); return Number.isFinite(x) ? x : 0; },
    responseAppliesToLatestRequest() { return true; },
  });
  const fn = catalog.slice(start, end);
  vm.runInContext(fn + '\nglobalThis.snapshot = modelSnapshot;', env);
  return env.snapshot(state);
}

const request = (model, locks = ['gpt-6', 'gpt-5.6-sol']) => ({
  phase: 'waiting', selectionRevision: 0,
  lastRequest: {
    model, requestId: 'r-123', selectionRevision: 0,
    capturedAt: '2026-10-15T03:20:00.000Z',
    policySnapshot: { lockedModels: locks },
  },
});

test('floating 锁定模型 waits for real outgoing request, not all checked locks', () => {
  const before = snapshot({ phase: 'idle' });
  assert.equal(before.request.id, null);
  assert.equal(before.request.label, '等待请求');

  const after = snapshot(request('gpt-5.6-sol'));
  assert.equal(after.request.id, 'gpt-5.6-sol');
  assert.doesNotMatch(after.request.label, /gpt-6.*gpt-5.6-sol/i);
  assert.equal(after.request.status, 'request');
});

test('floating 锁定模型 shows one final GPT-6 for served gpt-6-thinking transport', () => {
  const r = snapshot(request('gpt-6-thinking'));
  assert.equal(r.request.id, 'gpt-6');
  assert.equal(r.request.label, 'gpt-6');
  assert.equal(r.request.status, 'request');
});

test('floating 锁定模型 does not invent configured target when request is not allowed', () => {
  const r = snapshot(request('gpt-5.6-sol', ['gpt-6']));
  assert.equal(r.request.id, 'gpt-5.6-sol');
  assert.match(r.request.label, /不符合锁定/);
  assert.doesNotMatch(r.request.label, /gpt-6/);
});

test('unlocked normal Chat remains unconfigured rather than pretending a lock was sent', () => {
  const r = snapshot(request('gpt-6-thinking', []), []);
  assert.equal(r.request.id, null);
  assert.equal(r.request.label, '未锁定');
});

test('indicator label changes only the request row and tooltip, never actual served response', () => {
  assert.match(catalog, /data-source="request"[^>]*>.*?锁定模型/);
  assert.match(catalog, /\`锁定模型：\$\{requestDetail\}\`/);
  assert.match(catalog, /data-source="response"[^>]*>.*?响应模型/);
});

test('saved response history treats thinking family as allowed but keeps raw response', () => {
  const env = vm.createContext({});
  vm.runInContext(historyCode, env);
  const helper = env.__GPTLOCK_MODEL_STATUS_HISTORY__;
  assert.equal(helper.policyAllows('gpt-6-thinking', { lockedModels: ['gpt-6'] }), true);
  assert.equal(helper.policyAllows('gpt-6', { lockedModels: ['gpt-6-thinking'] }), true);
  assert.equal(helper.policyAllows('gpt-7-thinking', { lockedModels: ['gpt-6'] }), false);
  const state = {
    lastRequest: { model: 'gpt-6-thinking', capturedAt: new Date(Date.now() - 1000).toISOString() },
    lastVerification: {
      model: 'gpt-6-thinking',
      verifiedAt: new Date().toISOString(),
      evidenceSource: 'network_response_metadata',
      reasons: [],
      verdict: 'verified',
    },
  };
  const result = helper.selectStatus({ state, policy: { lockedModels: ['gpt-6'] } });
  assert.equal(result.response.id, 'gpt-6-thinking');
});
