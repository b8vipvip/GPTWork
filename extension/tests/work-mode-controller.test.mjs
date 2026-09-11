import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../work-mode-controller.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('Work controller is inert until both feature selection and background account gate allow it', () => {
  assert.match(source, /WORK_MODE_KEY = 'gptworkWorkModeEnabled'/);
  assert.match(source, /let workModeSelected = false/);
  assert.match(source, /let backgroundAllowed = false/);
  assert.match(source, /enabled = Boolean\(workModeSelected && backgroundAllowed\)/);
  assert.match(source, /account\?\.authenticated === true/);
  assert.match(source, /account\?\.entitlement\?\.active === true/);
});

test('new-chat Work clicks are guided back to Chat only when Work handling is enabled', () => {
  assert.match(source, /无需手动选择工作模式，在聊天模式直接发消息或任务后GPT自动以工作模式处理问题/);
  assert.match(source, /function isPristineNewChat/);
  assert.match(source, /function topModeControl/);
  assert.match(source, /switchBackToChat/);
  assert.match(source, /WORK_LABEL/);
  assert.match(source, /CHAT_LABEL/);
  assert.match(source, /if \(!enabled \|\| !isPristineNewChat\(\)\) return/);
});

test('processing mode requires Work conversation marker plus Work output/source panel evidence', () => {
  assert.match(source, /WORK_TITLE_SUFFIX/);
  assert.match(source, /输出内容/);
  assert.match(source, /来源/);
  assert.match(source, /创建文件或网站/);
  assert.match(source, /网页搜索/);
  assert.match(source, /文件搜索/);
  assert.match(source, /记忆/);
  assert.match(source, /conversationMarker && panel\.confirmed/);
  assert.match(source, /outsideConversation/);
  assert.match(source, /TURN_SELECTOR/);
});

test('floating model panel exposes message processing mode above the page model', () => {
  assert.match(source, /data-source="processing-mode"/);
  assert.match(source, /消息处理模式/);
  assert.match(source, /工作模式/);
  assert.match(source, /聊天模式/);
  assert.match(source, /button\.insertBefore\(row, pageRow\)/);
});

test('manifest loads Work controller immediately after the model indicator owner', () => {
  const scripts = manifest.content_scripts?.[0]?.js || [];
  const catalog = scripts.indexOf('model-catalog.js');
  const work = scripts.indexOf('work-mode-controller.js');
  const remaining = scripts.indexOf('chat-length-remaining-indicator.js');
  assert.ok(catalog >= 0);
  assert.equal(work, catalog + 1);
  assert.ok(remaining > work);
});
