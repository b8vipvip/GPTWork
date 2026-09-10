import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const account = readFileSync(join(ROOT, 'license-server/account-system.mjs'), 'utf8');
const popup = readFileSync(join(ROOT, 'extension/popup.html'), 'utf8');
const rewards = readFileSync(join(ROOT, 'extension/popup-rewards.js'), 'utf8');
const background = readFileSync(join(ROOT, 'extension/background.js'), 'utf8');
const plans = readFileSync(join(ROOT, 'license-server/public/admin-plans.html'), 'utf8');
const users = readFileSync(join(ROOT, 'license-server/public/admin-users.html'), 'utf8');

test('user levels replace public membership semantics and enforce requested defaults', () => {
  assert.match(account, /code: 'deep'.*?maxDevices: 1, maxWindows: 3/s);
  assert.match(account, /code: 'heavy'.*?maxDevices: 5, maxWindows: 5/s);
  assert.match(account, /user_level TEXT NOT NULL DEFAULT 'normal'/);
  assert.match(account, /levelDefinitions/);
  assert.match(account, /requested\.slice\(0, remaining\)/);
  assert.match(background, /allowed\.includes\(windowKey\)/);
});

test('popup exposes check-in +1, share +7 and upgrade entry', () => {
  assert.match(popup, /id="accountCheckin"/);
  assert.match(popup, /<sup>\+1<\/sup>/);
  assert.match(popup, /id="accountShare"/);
  assert.match(popup, /<sup>\+7<\/sup>/);
  assert.match(popup, /id="accountUpgrade"/);
  assert.match(rewards, /\/api\/v1\/account\/checkin/);
  assert.match(rewards, /share\?\.url/);
});

test('admin membership tab is now user configuration and user list says user level', () => {
  assert.match(plans, /用户配置/);
  assert.match(plans, /普通、深度、重度/);
  assert.match(users, /<th>用户等级<\/th>/);
});
