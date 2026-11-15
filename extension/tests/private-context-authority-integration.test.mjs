import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [manifestText, budgetText, authorityText, indicatorText, packageText, syntaxCheckText] = await Promise.all([
  readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
  readFile(new URL('../context-budget.js', import.meta.url), 'utf8'),
  readFile(new URL('../private-context-budget-authority.js', import.meta.url), 'utf8'),
  readFile(new URL('../chat-length-remaining-indicator.js', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/check-syntax.mjs', import.meta.url), 'utf8'),
]);

test('extension loads the private context budget authority instead of the old shadow', () => {
  assert.match(manifestText, /private-context-budget-authority\.js/);
  assert.doesNotMatch(manifestText, /private-context-budget-shadow\.js/);
  assert.match(packageText, /node scripts\\/check-syntax\\.mjs/);
  assert.match(syntaxCheckText, /private-context-budget-authority\\.js/);
  assert.doesNotMatch(syntaxCheckText, /private-context-budget-shadow\\.js/);
});

test('send-time guard continues to delegate exact private decisions to the private authority', () => {
  assert.match(budgetText, /__GPTLOCK_PRIVATE_CONTEXT_BUDGET_AUTHORITY__/);
  assert.match(budgetText, /authority\?\.shouldGuardSend\?\.\(\)/);
  assert.match(budgetText, /authority\.evaluateForSend\(\)/);
  assert.match(budgetText, /refreshPrivateHistory/);
  assert.match(budgetText, /privateHistoryParts/);
});

test('chat-length display is decoupled from private remainingPercent and keeps the public verified estimator', () => {
  assert.match(authorityText, /privateHistorySnapshot\?\.\(\)/);
  assert.match(indicatorText, /estimateTextTokens/);
  assert.match(indicatorText, /computeLocalBudget/);
  assert.match(indicatorText, /learned-chatgpt-thread-boundary/);
  assert.doesNotMatch(indicatorText, /__GPTLOCK_PRIVATE_CONTEXT_BUDGET_AUTHORITY__/);
});
