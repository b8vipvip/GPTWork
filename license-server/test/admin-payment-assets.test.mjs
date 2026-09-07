import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const settingsHtml = await readFile(new URL('../public/admin-settings.html', import.meta.url), 'utf8');
const saveModule = await readFile(new URL('../public/payment-method-save.js', import.meta.url), 'utf8');
const serverSource = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

test('admin payment method save module is referenced and served', () => {
  assert.match(settingsHtml, /<script\s+type="module"\s+src="\/payment-method-save\.js"><\/script>/);
  assert.match(serverSource, /url\.pathname === '\/payment-method-save\.js'[\s\S]*payment-method-save\.js/);
});

test('payment method save module persists WeChat and Alipay provider selection', () => {
  assert.match(saveModule, /saveWechatPaymentMethod/);
  assert.match(saveModule, /saveAlipayPaymentMethod/);
  assert.match(saveModule, /\/admin\/api\/official-payments\/\$\{code\}/);
  assert.match(saveModule, /\/site\/api\/payments/);
});
