import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

await import(`../context-budget.js?test=${Date.now()}`);
await import(`../chat-length-remaining-indicator.js?test=${Date.now()}`);
const budget = globalThis.__GPTLOCK_CONTEXT_BUDGET__;
const indicator = globalThis.__GPTLOCK_CHAT_LENGTH_REMAINING_INDICATOR__;
const contextSource = await readFile(new URL('../context-budget.js', import.meta.url), 'utf8');
const backgroundSource = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('two conversations keep independent persistent checkpoint keys', () => {
  const a = budget.checkpointStorageKey('acct-one', 'conv-a', 'gpt-5.6-sol');
  const b = budget.checkpointStorageKey('acct-one', 'conv-b', 'gpt-5.6-sol');
  assert.notEqual(a, b);
});

test('two conversations calculate remaining percentage from their own token usage', () => {
  const aBudget = indicator.computeLocalBudget({
    historyTokens: 766_920,
    contextLimitTokens: 1_050_000,
  });
  const bBudget = indicator.computeLocalBudget({
    historyTokens: 194_040,
    contextLimitTokens: 1_050_000,
  });
  const a = indicator.calculateRemainingPercent({
    hardLimitVisible: false,
    localBudget: { ...aBudget, learnedHardLimitActive: false },
  });
  const b = indicator.calculateRemainingPercent({
    hardLimitVisible: false,
    localBudget: { ...bBudget, learnedHardLimitActive: false },
  });
  assert.equal(indicator.formatPercent(a.percent), '17.0%');
  assert.equal(indicator.formatPercent(b.percent), '79.0%');
  assert.notEqual(a.percent, b.percent);
});

test('SPA navigation and in-flight history requests are conversation-key aware', () => {
  assert.match(contextSource, /function ensureConversationNavigation\(\)/);
  assert.match(contextSource, /ensureConversationNavigation\(\);[\s\S]*findVisibleConversationLengthLimit/);
  assert.match(contextSource, /conversationMetricsPromiseKey === conversationKey/);
  assert.match(contextSource, /requestSequence !== conversationMetricsRequestSequence/);
  assert.match(contextSource, /checkpointMatched \? storedMetric\(restoredCheckpoint\.cumulativeTokens\) : 0/);
  assert.match(backgroundSource, /GPTLOCK_CONTEXT_BUDGET_DIAGNOSTIC/);
  assert.match(backgroundSource, /'context-budget', 'remaining_snapshot'/);
});
