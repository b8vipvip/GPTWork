import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const server = readFileSync(resolve(root, 'license-server/site-account.mjs'), 'utf8');
const account = readFileSync(resolve(root, 'license-server/public/account.html'), 'utf8');
const rewards = readFileSync(resolve(root, 'license-server/public/account-rewards.js'), 'utf8');
const releases = readFileSync(resolve(root, 'license-server/public/releases.html'), 'utf8');
const extensionAccount = readFileSync(resolve(root, 'extension/account.html'), 'utf8');

test('account rewards are persisted and exposed through authenticated site APIs', () => {
  assert.match(server, /CREATE TABLE IF NOT EXISTS account_daily_checkins/);
  assert.match(server, /PRIMARY KEY\(user_id, day_key\)/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS account_invite_codes/);
  assert.match(server, /invitee_user_id INTEGER NOT NULL UNIQUE/);
  assert.match(server, /CHECKIN_REWARD_DAYS = 1/);
  assert.match(server, /INVITE_REWARD_DAYS = 7/);
  assert.match(server, /\/site\/api\/account\/checkin/);
  assert.match(server, /\/site\/api\/account\/invite\/redeem/);
  assert.match(server, /SELF_INVITE_NOT_ALLOWED/);
  assert.match(server, /INVITE_ALREADY_REDEEMED/);
});

test('account center hides membership plans and exposes check-in and invite controls', () => {
  assert.match(account, /id="rewardSection"/);
  assert.match(account, /id="dailyCheckin"/);
  assert.match(account, /id="copyInvite"/);
  assert.match(account, /每日签到 \+1 天/);
  assert.match(account, /每成功邀请 1 个已验证账户增加 7 天/);
  assert.match(account, /<div class="account-section" hidden aria-hidden="true"><h3>会员方案<\/h3>/);
  assert.match(extensionAccount, /<section class="card" hidden aria-hidden="true">\s*<div class="section-title"><div><h2>会员方案<\/h2>/);
  assert.match(rewards, /\/site\/api\/account\/checkin/);
  assert.match(rewards, /\/site\/api\/account\/invite\/redeem/);
});

test('official releases page keeps v0.5.48 and newer only', () => {
  assert.match(releases, /v0\.5\.48 及之后版本/);
  assert.match(releases, /\[0,5,48,0\]/);
  assert.match(releases, /querySelectorAll\('\.release-card'\)/);
  assert.match(releases, /GPTWorkSetup-x64/);
  assert.match(releases, /amd64/);
});
