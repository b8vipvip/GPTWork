import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { rewriteConversationPostData } from '../network-evidence.js';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');


test('Picker B compatibility is no longer queued by Discover Models', () => {
  const body = background.slice(background.indexOf('async function verifyAccountCatalogModels'), background.indexOf('function modelVerificationHistoryRecord'));
  assert.match(body, /picker_a_chat_lock_queued/);
  assert.doesNotMatch(body, /discoverOfficialWorkModels\(tabId, progress\)/);
  assert.doesNotMatch(body, /picker-b-chat-compatibility/);
  assert.doesNotMatch(body, /selectorKey: '__work_transport__'/);
  assert.doesNotMatch(background, /network_work_catalog_seeded/);
});

test('forced GPT-6 Astra verification model is converted to its Work transport', () => {
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
