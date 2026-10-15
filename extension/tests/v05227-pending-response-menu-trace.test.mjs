import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [content, catalog, background] = await Promise.all([
  readFile(new URL('../content.js', import.meta.url), 'utf8'),
  readFile(new URL('../model-catalog.js', import.meta.url), 'utf8'),
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
]);

test('passive external-menu observation does not refer to removed alignment state', () => {
  const start = content.indexOf('function externalMenuProgrammaticTrace(event, trigger) {');
  const end = content.indexOf("\n document.addEventListener('pointerdown'", start);
  const endFallback = content.indexOf("\ndocument.addEventListener('pointerdown'", start);
  const section = content.slice(start, end >= 0 ? end : endFallback);
  assert.ok(start > 0 && section.includes('return details;'), 'expected trace function');
  assert.doesNotMatch(section, /\blastAlignAttempt\b|\blastAlignAt\b/);
  const observed = [];
  const runtime = vm.createContext({
    compactElementProbe() { return { tag: 'button' }; },
    location: { href: 'https://chatgpt.com/c/active' },
    autoProbeRunning: false,
    autoVerificationRunning: false,
    cachedState: null,
    pointerTraceSeq: 0,
    pointerTrace(event, details) { observed.push({ event, details }); },
  });
  vm.runInContext(section + '\nglobalThis.trace = externalMenuProgrammaticTrace;', runtime);
  const trigger = { getAttribute() { return 'history-item-5-options'; } };
  const details = runtime.trace({ isTrusted: true, type: 'click' }, trigger);
  assert.equal(details.historyOptions, true);
  assert.equal(details.autoVerificationRunning, false);
  assert.equal(details.target.tag, 'button');
  assert.equal(observed.length, 0);
  runtime.trace({ isTrusted: false, type: 'click' }, trigger);
  assert.equal(observed.at(-1).event, 'history_menu_programmatic_event');
});

const start = catalog.indexOf('  function modelSnapshot(state) {');
const end = catalog.indexOf('\n  function rememberModels(candidates) {', start);
assert.ok(start >= 0 && end > start, 'modelSnapshot function boundary');

test('generating response without authoritative model does not invent final served model', () => {
  const runtime = vm.createContext({
    currentPolicy: { lockedModels: ['gpt-5.6-sol'] },
    trustedStatus: null,
    normalizeModelId(v) { return v || null; },
    normalizeConcreteModelId(v) { return v || null; },
    modelLabel(v) { return v; },
    effectivePageObservation(state) { return state.pageObservation || null; },
    timestamp(value) { return Date.parse(value || '') || 0; },
    responseAppliesToLatestRequest() { return false; },
  });
  vm.runInContext(catalog.slice(start, end) + '\nglobalThis.snapshot = modelSnapshot;', runtime);
  const snapshot = runtime.snapshot({
    phase: 'waiting',
    lastRequest: {
      requestId: '15316.3995',
      capturedAt: new Date().toISOString(),
      model: 'gpt-6-thinking',
      reasoning: 'high',
      policySnapshot: { lockedModels: ['gpt-5.6-sol'] },
    },
    lastResponseEvidence: null,
    lastVerification: null,
  });
  assert.equal(snapshot.response.id, null);
  assert.match(snapshot.response.label, /生成中.*等待真实响应模型证据/);
  assert.equal(snapshot.response.status, 'waiting');
  assert.equal(snapshot.request.id, 'gpt-6');
  assert.match(snapshot.request.label, /不符合锁定/);
});

test('no formal request does not falsely claim ongoing generation', () => {
  const runtime = vm.createContext({
    currentPolicy: { lockedModels: ['gpt-6'] },
    trustedStatus: null,
    normalizeModelId(v) { return v || null; },
    normalizeConcreteModelId(v) { return v || null; },
    modelLabel(v) { return v; },
    effectivePageObservation(state) { return state.pageObservation || null; },
    timestamp(value) { return Date.parse(value || '') || 0; },
    responseAppliesToLatestRequest() { return false; },
  });
  vm.runInContext(catalog.slice(start, end) + '\nglobalThis.snapshot = modelSnapshot;', runtime);
  const snapshot = runtime.snapshot({ phase: 'waiting' });
  assert.equal(snapshot.response.id, null);
  assert.doesNotMatch(snapshot.response.label, /生成中/);
});

test('confirmed model mismatch is not falsely diagnosed as missing response metadata', () => {
  const start = background.indexOf('function diagnoseEvidenceIssue(evidence, result) {');
  const end = background.indexOf('\nasync function applyNetworkEvidence(', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({});
  vm.runInContext(background.slice(start, end) + '\nglobalThis.diagnose = diagnoseEvidenceIssue;', context);
  const evidence = { diagnostics: { bodyFormat: 'json' }, conflicts: { model: false, reasoning: false } };
  assert.equal(context.diagnose(evidence, {
    verdict: 'mismatch', reason: 'model_not_allowed', reasons: ['model_not_allowed'],
  }), 'response_model_not_allowed');
  assert.equal(context.diagnose(evidence, {
    verdict: 'mismatch', reason: 'reasoning_not_allowed', reasons: ['reasoning_not_allowed'],
  }), 'response_reasoning_not_allowed');
  assert.equal(context.diagnose(evidence, { verdict: 'unverified', reason: 'reasoning_missing' }), 'response_reasoning_not_exposed');
  assert.equal(context.diagnose(evidence, { verdict: 'unverified', reason: 'unconfirmed' }), 'response_metadata_incomplete');
  assert.equal(context.diagnose(evidence, { verdict: 'verified' }), null);
});
