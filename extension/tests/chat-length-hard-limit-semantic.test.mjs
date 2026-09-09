import assert from 'node:assert/strict';
import test from 'node:test';

await import(`../chat-length-hard-limit-semantic.js?test=${Date.now()}`);
const bridge = globalThis.__GPTLOCK_CHAT_LENGTH_HARD_LIMIT_SEMANTIC__;

const classifier = (text) => /你已(?:到达|达到)(?:此)?对话的长度上限/.test(text)
  ? { matched: true, kind: 'conversation-length-limit' }
  : null;

test('plain out-of-turn ChatGPT length-limit paragraph/div/span qualifies for semantic normalization', () => {
  assert.equal(bridge.shouldNormalizeCandidate({
    text: '你已达到此对话的长度上限，你可以开始新聊天以继续对话。',
    classifier,
    insideConversation: false,
    containsConversation: false,
    ownNotice: false,
  }), true);
});

test('quoted hard-limit text inside a normal conversation turn is never normalized', () => {
  assert.equal(bridge.shouldNormalizeCandidate({
    text: '你已达到此对话的长度上限，你可以开始新聊天以继续对话。',
    classifier,
    insideConversation: true,
    ownNotice: false,
  }), false);
});

test('wrapper elements containing conversation turns are never normalized', () => {
  assert.equal(bridge.shouldNormalizeCandidate({
    text: '你已达到此对话的长度上限，你可以开始新聊天以继续对话。',
    classifier,
    containsConversation: true,
  }), false);
});

test('GPTWork own notices are never normalized as ChatGPT system chrome', () => {
  assert.equal(bridge.shouldNormalizeCandidate({
    text: '你已达到此对话的长度上限，你可以开始新聊天以继续对话。',
    classifier,
    insideConversation: false,
    ownNotice: true,
  }), false);
});

test('unrelated out-of-turn text does not qualify', () => {
  assert.equal(bridge.shouldNormalizeCandidate({
    text: 'ChatGPT 也可能会犯错，请核查重要信息。',
    classifier,
  }), false);
});
