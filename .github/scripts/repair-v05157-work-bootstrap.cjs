const fs = require('node:fs');
const path = 'extension/background.js';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`missing source anchor: ${label}`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error(`non-unique source anchor: ${label}`);
  source = source.slice(0, first) + newText + source.slice(first + oldText.length);
}
function replaceBetween(startText, endText, newText, label) {
  const start = source.indexOf(startText);
  if (start < 0) throw new Error(`missing start anchor: ${label}`);
  const end = source.indexOf(endText, start + startText.length);
  if (end < 0) throw new Error(`missing end anchor: ${label}`);
  source = source.slice(0, start) + newText + source.slice(end);
}

replaceOnce(
  "// One-shot Work bootstrap follows normal Work policy outside verification authority.\nconst workBootstrapTabs = new Set();\n",
  "",
  'legacy Work bootstrap Set'
);

replaceBetween(
  'function verificationTransactionForTab(tabId) {',
  'function runtimePolicyForTabSync(tabId) {',
`function verificationTransactionForTab(tabId) {
  return verificationTransactions.get(Number(tabId)) || null;
}

function workBootstrapModelForTab(tabId) {
  const policy = effectivePolicyForTabSync(tabId);
  return normalizeConcreteModelId(policy.lockedModels?.[0])
    ?? normalizeConcreteModelId(DEFAULT_POLICY.lockedModels?.[0]);
}

function beginWorkBootstrapTransaction(tabId, source) {
  const normalizedTabId = Number(tabId);
  const previous = verificationTransactionForTab(normalizedTabId);
  const model = workBootstrapModelForTab(normalizedTabId);
  if (!model) throw new Error('Work bootstrap model is unavailable');
  verificationTransactions.set(normalizedTabId, {
    model,
    selectorKey: '__work_bootstrap__',
    label: 'Work bootstrap',
    startedAt: Date.now(),
    kind: 'work-bootstrap',
    source: String(source || 'work-bootstrap'),
  });
  return { previous, model };
}

function endWorkBootstrapTransaction(tabId, previous) {
  const normalizedTabId = Number(tabId);
  if (previous) verificationTransactions.set(normalizedTabId, previous);
  else verificationTransactions.delete(normalizedTabId);
}

`,
  'verification transaction helper section'
);

replaceBetween(
  '  getLockConfiguration(tabId) {',
  '  getVerificationTransaction(tabId) {',
`  getLockConfiguration(tabId) {
    const policy = runtimePolicyForTabSync(tabId);
    return {
      lockedModels: policy.lockedModels,
      allowedReasoningLevels: policy.allowedReasoningLevels,
      preferredReasoning: currentSettings.preferredReasoning,
      preserveModel: false,
      preserveReasoning: false,
      bypassRewrite: false,
      forceModel: null,
      responseVerificationEnabled: currentSettings.networkVerificationEnabled,
      knownModels: [...sharedKnownModelIds],
    };
  },
`,
  'network lock configuration'
);

replaceBetween(
  '  workBootstrapTabs.add(Number(tabId));',
  '  const deadline = Date.now() + 10000;',
`  const workBootstrap = beginWorkBootstrapTransaction(tabId, 'picker-b-reacquire');
  try {
    const probe = await sendVerificationReasoningProbe(tabId, 'work-mode-b-reacquire', progress.completed + 1, progress.total);
    if (!probe?.sent) return catalog;
    const settled = await sendTabMessage(tabId, { type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED', assistantCountBefore: probe.assistantCountBefore ?? 0, timeoutMs: AUTO_VERIFY_RESPONSE_TIMEOUT_MS });
    if (settled?.settled !== true) return catalog;
  } finally {
    endWorkBootstrapTransaction(tabId, workBootstrap.previous);
  }
`,
  'Picker B reacquire bootstrap authority'
);

replaceBetween(
  '        workBootstrapTabs.add(Number(tabId));',
  '        // Do not reload/stop/recover this bootstrap turn.',
`        const workBootstrap = beginWorkBootstrapTransaction(tabId, 'post-sol-work-activation');
        try {
          activationProbe = await sendVerificationReasoningProbe(tabId, 'work-mode-bootstrap', index, queue.length);
          if (activationProbe?.sent) {
            activationSettled = await sendTabMessage(tabId, {
              type: 'GPTLOCK_WAIT_FOR_PROBE_SETTLED',
              assistantCountBefore: activationProbe.assistantCountBefore ?? 0,
              timeoutMs: AUTO_VERIFY_RESPONSE_TIMEOUT_MS,
            });
          }
        } finally {
          endWorkBootstrapTransaction(tabId, workBootstrap.previous);
        }

`,
  'post-Sol bootstrap authority'
);

replaceOnce(
  "&& activationRewrite?.authorityKind === 'normal-policy'",
  "&& activationRewrite?.authorityKind === 'verification-transaction'",
  'activation rewrite authority check'
);

source = source
  .replace(
    '// ordinary natural turn outside verificationTransactions. That request therefore\n    // belongs exclusively to normal-policy (not the verification authority). Only the\n    // real B catalog is allowed to confirm the A -> Work/B transition.',
    '// one-shot natural turn through the same verification transaction authority used\n    // at Fetch.requestPaused. Only the real B catalog or backend Work identity may\n    // confirm the A -> Work/B transition.'
  )
  .replaceAll("source: 'normal_work_policy_request'", "source: 'work_bootstrap_transaction'");

if (source.includes('workBootstrapTabs')) throw new Error('legacy workBootstrapTabs authority remains');
fs.writeFileSync(path, source);

fs.writeFileSync('extension/tests/v05155-work-bootstrap-policy.test.mjs', `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('verification Work bootstrap resolves the effective Work policy without a parallel tab Set', () => {
  const start = background.indexOf('function workBootstrapModelForTab(tabId) {');
  const end = background.indexOf('function beginWorkBootstrapTransaction', start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);
  assert.match(block, /effectivePolicyForTabSync\\(tabId\\)/);
  assert.match(block, /normalizeConcreteModelId\\(policy\\.lockedModels\\?\\.\\[0\\]\\)/);
  assert.match(block, /normalizeConcreteModelId\\(DEFAULT_POLICY\\.lockedModels\\?\\.\\[0\\]\\)/);
  assert.doesNotMatch(background, /workBootstrapTabs/);
});

test('failed Work discovery cannot be reported as a fully verified account', () => {
  assert.match(background, /catalogVerification\\?\\.workDiscovery\\?\\.attempted === true/);
  assert.match(background, /catalogVerification\\.workDiscovery\\.entered !== true/);
  assert.match(background, /finalReason = 'work_model_discovery_incomplete'/);
});
`);

fs.writeFileSync('extension/tests/v05156-work-bootstrap-force.test.mjs', `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { rewriteConversationPostData } from '../network-evidence.js';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('Work bootstrap forces its effective Work model through verificationTransactions', () => {
  const start = background.indexOf('function beginWorkBootstrapTransaction(tabId, source) {');
  const end = background.indexOf('function endWorkBootstrapTransaction', start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);
  assert.match(block, /const model = workBootstrapModelForTab\\(normalizedTabId\\)/);
  assert.match(block, /verificationTransactions\\.set\\(normalizedTabId/);
  assert.match(block, /kind: 'work-bootstrap'/);
  assert.match(block, /return \\{ previous, model \\}/);
});

test('forced Work bootstrap model is converted to its Work transport even when the visible Chat model is known', () => {
  const rewritten = rewriteConversationPostData(JSON.stringify({
    model: 'gpt-5.6-sol',
    thinking_effort: 'high',
  }), {
    lockedModels: ['gpt-6-astra'],
    knownModels: ['gpt-5.6-sol', 'gpt-6-astra'],
    forceModel: 'gpt-6-astra',
    preserveModel: false,
    preserveReasoning: true,
    allowedReasoningLevels: ['high'],
  });
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.modelBefore, 'gpt-5.6-sol');
  assert.equal(rewritten.modelAfter, 'gpt-6-astra');
  assert.equal(rewritten.transportModelAfter, 'gpt-6-astra-wm');
  assert.equal(rewritten.reason, 'verification_model_forced');
});
`);

fs.writeFileSync('extension/tests/v05157-work-bootstrap-transaction-authority.test.mjs', `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const monitor = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');

test('v0.5.157 Work bootstrap has one terminal request authority', () => {
  assert.doesNotMatch(background, /workBootstrapTabs/);
  assert.match(background, /beginWorkBootstrapTransaction\\(tabId, 'picker-b-reacquire'\\)/);
  assert.match(background, /endWorkBootstrapTransaction\\(tabId, workBootstrap\\.previous\\)/);
  assert.match(background, /beginWorkBootstrapTransaction\\(tabId, 'post-sol-work-activation'\\)/);
  assert.match(background, /activationRewrite\\?\\.authorityKind === 'verification-transaction'/);
  assert.match(monitor, /authorityKind: 'verification-transaction'/);
  assert.match(monitor, /forceModel: model/);
});

test('nested Picker B bootstrap restores the catalog verification transaction', () => {
  const start = background.indexOf('async function reacquirePickerBForModel');
  const end = background.indexOf('async function verifyAccountCatalogModels', start);
  const block = background.slice(start, end);
  assert.match(block, /const workBootstrap = beginWorkBootstrapTransaction/);
  assert.match(block, /finally \\{[\\s\\S]*endWorkBootstrapTransaction\\(tabId, workBootstrap\\.previous\\)/);
});
`);
