import assert from 'node:assert/strict';
import test from 'node:test';

await import(`../chat-length-remaining-truth.js?test=${Date.now()}`);
const truth = globalThis.__GPTLOCK_CHAT_LENGTH_REMAINING_TRUTH__;

const classifier = (text) => /你已(?:到达|达到)(?:此)?对话的长度上限/.test(text)
  ? { matched: true, locale: 'zh-CN' }
  : null;

test('plain div/span ChatGPT hard-limit chrome is accepted outside conversation turns', () => {
  assert.equal(truth.shouldTreatAsHardLimit({
    text: '你已达到此对话的长度上限，你可以开始新聊天以继续对话。',
    classifier,
    ownNotice: false,
    insideConversation: false,
    containsConversation: false,
  }), true);
});

test('quoted hard-limit text in or around a conversation turn is rejected', () => {
  const text = '你已达到此对话的长度上限，你可以开始新聊天以继续对话。';
  assert.equal(truth.shouldTreatAsHardLimit({ text, classifier, insideConversation: true }), false);
  assert.equal(truth.shouldTreatAsHardLimit({ text, classifier, containsConversation: true }), false);
});

test('GPTWork own notices never become ChatGPT hard-limit evidence', () => {
  assert.equal(truth.shouldTreatAsHardLimit({
    text: '你已达到此对话的长度上限，你可以开始新聊天以继续对话。',
    classifier,
    ownNotice: true,
  }), false);
});

test('visible ChatGPT hard limit always overrides any local estimate with zero', () => {
  assert.deepEqual(truth.decideDisplay({
    hardLimitVisible: true,
    historyMeasurementSource: 'dom-fallback',
    fullHistoryAvailable: false,
  }), {
    text: '0%',
    status: 'danger',
    source: 'chatgpt-visible-hard-limit',
    detail: '当前页面检测到 ChatGPT 自身的“对话长度上限”系统提示，因此本聊天的可继续长度以 ChatGPT 实际状态为准：0%。',
  });
});

test('partial DOM fallback never presents a fake precise percentage', () => {
  const decision = truth.decideDisplay({
    hardLimitVisible: false,
    historyMeasurementSource: 'dom-fallback',
    fullHistoryAvailable: false,
  });
  assert.equal(decision.text, '未知');
  assert.equal(decision.status, 'unknown');
  assert.equal(decision.source, 'partial-dom-unknown');
});

test('complete conversation history leaves normal estimator in control', () => {
  assert.equal(truth.decideDisplay({
    hardLimitVisible: false,
    historyMeasurementSource: 'conversation-tree',
    fullHistoryAvailable: true,
  }), null);
  assert.equal(truth.decideDisplay({
    hardLimitVisible: false,
    historyMeasurementSource: 'dom-fallback',
    fullHistoryAvailable: true,
  }), null);
});
