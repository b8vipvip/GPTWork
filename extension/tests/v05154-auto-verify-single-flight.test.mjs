import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('v0.5.154 serializes automatic model verification per tab', () => {
  assert.match(background, /const autoVerificationTasks = new Map\(\)/);
  const start = background.indexOf("case 'GPTLOCK_AUTO_VERIFY'");
  const end = background.indexOf("case 'GPTLOCK_SEND_BLOCKED'", start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);
  assert.match(block, /autoVerificationTasks\.get\(tabId\)/);
  assert.match(block, /auto_verify_duplicate_joined/);
  assert.match(block, /const task = autoVerify\(tabId\)/);
  assert.match(block, /autoVerificationTasks\.set\(tabId, task\)/);
  assert.match(block, /return await task/);
  assert.match(block, /autoVerificationTasks\.get\(tabId\) === task/);
  assert.match(block, /autoVerificationTasks\.delete\(tabId\)/);
});

test('v0.5.154 registers the task before awaiting it', () => {
  const start = background.indexOf("case 'GPTLOCK_AUTO_VERIFY'");
  const end = background.indexOf("case 'GPTLOCK_SEND_BLOCKED'", start);
  const block = background.slice(start, end);
  const createAt = block.indexOf('const task = autoVerify(tabId)');
  const setAt = block.indexOf('autoVerificationTasks.set(tabId, task)');
  const awaitAt = block.indexOf('return await task');
  assert.ok(createAt >= 0 && setAt > createAt && awaitAt > setAt);
});
