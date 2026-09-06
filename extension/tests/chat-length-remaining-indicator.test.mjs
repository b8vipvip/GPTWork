import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

await import(`../chat-length-remaining-indicator.js?test=${Date.now()}`);
const indicator = globalThis.__GPTLOCK_CHAT_LENGTH_REMAINING_INDICATOR__;
const source = await readFile(new URL('../chat-length-remaining-indicator.js', import.meta.url), 'utf8');

test('currently visible ChatGPT system hard limit forces remaining chat length to zero', () => {
  const result = indicator.calculateRemainingPercent({
    snapshot: { hardLimitVisible: false, model: 'gpt-5.6-sol' },
    hardLimitVisible: true,
    localBudget: { safeLimitTokens: 924_000, remainingTokens: 800_000 },
  });
  assert.equal(result.percent, 0);
  assert.equal(result.source, 'chatgpt-visible-hard-limit');
});

test('stale snapshot hard-limit flag no longer pins a healthy conversation at zero', () => {
  const result = indicator.calculateRemainingPercent({
    snapshot: { hardLimitVisible: true, model: 'gpt-5.6-sol' },
    hardLimitVisible: false,
    localBudget: {
      safeLimitTokens: 924_000,
      remainingTokens: 831_600,
      learnedHardLimitActive: false,
    },
  });
  assert.equal(result.source, 'local-operational-budget');
  assert.equal(result.percent, 90);
});

test('GPT-5.6 local budget preserves the verified 88 percent safety window', () => {
  const window = indicator.contextWindowForModel('gpt-5.6-sol');
  const budget = indicator.computeLocalBudget({
    historyTokens: 92_400,
    draftTokens: 0,
    contextLimitTokens: window.tokens,
  });
  assert.equal(window.tokens, 1_050_000);
  assert.equal(budget.safeLimitTokens, 924_000);
  assert.equal(budget.remainingTokens, 831_600);
  assert.equal(budget.remainingPercent, 90);
});

test('web thinking alias shares the GPT-5.6 Sol context family', () => {
  assert.equal(indicator.normalizeModelId('gpt-5-6-thinking'), 'gpt-5.6-sol');
  const window = indicator.contextWindowForModel('gpt-5-6-thinking');
  assert.equal(window.tokens, 1_050_000);
  assert.equal(window.model, 'gpt-5.6-sol');
});

test('old tiny learned cap like the runtime-log 9.6k sample is rejected', () => {
  const upper = indicator.credibleHardLimitUpperBound({
    profile: {
      hardLimitTokenCapUsable: true,
      hardLimitConfidence: 'measured-upper-bound',
      hardLimitUpperBoundTokens: 9_654,
      confirmedConversationTokens: 0,
    },
    contextLimitTokens: 1_050_000,
    currentTokens: 9_000,
  });
  assert.equal(indicator.hardLimitSanityFloor(1_050_000), 231_000);
  assert.equal(upper, 0);
});

test('current conversation crossing an old learned cap automatically contradicts it', () => {
  const upper = indicator.credibleHardLimitUpperBound({
    profile: {
      hardLimitTokenCapUsable: true,
      hardLimitConfidence: 'measured-upper-bound',
      hardLimitUpperBoundTokens: 500_000,
      confirmedConversationTokens: 300_000,
    },
    contextLimitTokens: 1_050_000,
    currentTokens: 510_000,
  });
  assert.equal(upper, 0);
});

test('credible measured token upper bound can still drive learned remaining display', () => {
  const upper = indicator.credibleHardLimitUpperBound({
    profile: {
      hardLimitTokenCapUsable: true,
      hardLimitConfidence: 'measured-upper-bound',
      hardLimitUpperBoundTokens: 950_000,
      confirmedConversationTokens: 900_000,
    },
    contextLimitTokens: 1_050_000,
    currentTokens: 900_000,
  });
  assert.equal(upper, 950_000);
  const budget = indicator.computeLocalBudget({
    historyTokens: 900_000,
    contextLimitTokens: 1_050_000,
    hardLimitUpperBoundTokens: upper,
    confirmedLowerBoundTokens: 900_000,
  });
  const result = indicator.calculateRemainingPercent({
    hardLimitVisible: false,
    localBudget: { ...budget, learnedHardLimitActive: true },
  });
  assert.equal(result.source, 'learned-chatgpt-thread-boundary');
  assert.equal(result.metricCount, 1);
  assert.ok(result.percent > 5 && result.percent < 6);
});

test('message and character observations are no longer hard-boundary inputs', () => {
  const result = indicator.calculateRemainingPercent({
    hardLimitVisible: false,
    localBudget: {
      safeLimitTokens: 924_000,
      remainingTokens: 700_000,
      cumulativeCharacters: 999_999_999,
      cumulativeMessages: 99_999,
      learnedHardLimitActive: false,
    },
  });
  assert.equal(result.source, 'local-operational-budget');
  assert.ok(result.percent > 75 && result.percent < 76);
});

test('chat length display no longer waits for or consumes private remainingPercent', () => {
  const result = indicator.calculateRemainingPercent({
    snapshot: {
      budgetAuthority: 'private-engine',
      remainingPercent: 3,
      model: 'gpt-5.6-sol',
    },
    hardLimitVisible: false,
    localBudget: {
      safeLimitTokens: 1_000,
      remainingTokens: 750,
      cumulativeTokens: 250,
      cumulativeCharacters: 1_000,
      cumulativeMessages: 10,
      learnedHardLimitActive: false,
    },
  });
  assert.equal(result.source, 'local-operational-budget');
  assert.equal(result.percent, 75);
  assert.equal(indicator.formatPercent(result.percent), '75.0%');
  assert.match(source, /estimateTextTokens/);
  assert.match(source, /local-operational-budget/);
  assert.doesNotMatch(source, /__GPTLOCK_PRIVATE_CONTEXT_BUDGET_AUTHORITY__/);
});

test('unknown models retain the conservative fallback window', () => {
  const window = indicator.contextWindowForModel('some-new-model');
  assert.equal(window.tokens, 128_000);
  assert.equal(window.source, 'conservative-fallback');
});

test('remaining display keeps one decimal so active conversations visibly move', () => {
  assert.equal(indicator.formatPercent(17.34), '17.3%');
  assert.equal(indicator.formatPercent(16.96), '17.0%');
  assert.equal(indicator.formatPercent(16.94), '16.9%');
});

test('diagnostic hashes do not expose raw conversation ids', () => {
  const one = indicator.diagnosticConversationHash('conversation:alpha-secret-id');
  const two = indicator.diagnosticConversationHash('conversation:beta-secret-id');
  assert.match(one, /^ctx-[0-9a-f]{8}$/);
  assert.notEqual(one, two);
  assert.doesNotMatch(one, /alpha|secret/i);
});
