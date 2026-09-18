import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const popupUrl = new URL('../popup-v0513.html', import.meta.url);
const popupCssUrl = new URL('../popup-v0513.css', import.meta.url);
const helpUrl = new URL('../help.html', import.meta.url);
const helpScriptUrl = new URL('../popup-help.js', import.meta.url);

test('popup removes verbose status cards, keeps help in the action row, and moves settings into account card', async () => {
  const popup = await readFile(popupUrl, 'utf8');
  const css = await readFile(popupCssUrl, 'utf8');

  assert.doesNotMatch(popup, /<section class="summary"/);
  assert.doesNotMatch(popup, /<p class="boundary"/);
  assert.doesNotMatch(popup, /GPTWork 会在正式聊天 POST 发出前尝试锁定/);
  assert.match(popup, /<section class="account-card">[\s\S]*?<button id="options"[^>]*>设置<\/button>/);
  assert.match(popup, /<div class="actions"[^>]*>[\s\S]*?<button id="help"[^>]*>使用帮助<\/button>[\s\S]*?<\/div>/);
  assert.match(popup, /src="popup-help\.js"/);
  assert.match(css, /grid-template-columns:\s*repeat\(3,/);
  assert.match(css, /\.account-settings-button/);
});

test('local help button opens an extension-bundled help page', async () => {
  const help = await readFile(helpUrl, 'utf8');
  const script = await readFile(helpScriptUrl, 'utf8');

  assert.match(help, /GPTWork 使用帮助/);
  assert.match(help, /这是随扩展安装的本地帮助页面/);
  assert.match(help, /data-gptwork-module="help"/);
  assert.match(script, /chrome\.runtime\.getURL\('help\.html'\)/);
  assert.match(script, /chrome\.tabs\.create\(\{ url \}\)/);
});
