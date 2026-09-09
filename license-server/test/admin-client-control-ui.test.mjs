import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const usersHtml = await readFile(new URL('../public/admin-users.html', import.meta.url), 'utf8');
const usersJs = await readFile(new URL('../public/admin-users.js', import.meta.url), 'utf8');
const updateHtml = await readFile(new URL('../public/admin-update.html', import.meta.url), 'utf8');
const updateJs = await readFile(new URL('../public/admin-client-control.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const updater = await readFile(new URL('../../extension/background-update.js', import.meta.url), 'utf8');

test('user admin is a plain-value list with client version and online state', () => {
  assert.match(usersHtml, /<h2>用户列表<\/h2>/);
  assert.match(usersHtml, /<th>客户端版本<\/th>/);
  assert.match(usersHtml, /<th>在线状态<\/th>/);
  assert.doesNotMatch(usersHtml, /<th>有效期<\/th>/);
  assert.match(usersHtml, /src="\/admin-users\.js"/);
  assert.doesNotMatch(usersHtml, /src="\/admin\.js"/);

  assert.match(usersJs, /iconButton\('✎'/);
  assert.match(usersJs, /iconButton\('⚙'/);
  assert.match(usersJs, /clientVersion/);
  assert.match(usersJs, /loggedInDevices/);
  assert.match(usersJs, /onlineDevices/);
  assert.match(usersJs, /重置账户/);
  assert.doesNotMatch(usersJs, /保存信息\/权益/);
  assert.doesNotMatch(usersJs, /重置设备/);
});

test('update admin exposes managed automatic updates and explicit all-user sync', () => {
  assert.match(updateHtml, /客户端更新配置/);
  assert.match(updateHtml, /id="clientAutoUpdateEnabled"/);
  assert.match(updateHtml, /id="syncClientVersions"[^>]*>同步客户端版本<\/button>/);
  assert.match(updateHtml, /src="\/admin-client-control\.js"/);
  assert.match(updateJs, /\/admin\/api\/client-control\/sync-all/);
  assert.match(updateJs, /autoUpdateEnabled/);
});

test('server exposes client-control APIs and dedicated admin assets', () => {
  assert.match(server, /createClientControlSystem/);
  assert.match(server, /clientControl\.handleApi/);
  assert.match(server, /clientControl\.handleAdmin/);
  assert.match(server, /clientControl\.handleSite/);
  assert.match(server, /\/admin-users\.js/);
  assert.match(server, /\/admin-client-control\.js/);
});

test('extension gates automatic release checks and consumes queued admin commands', () => {
  assert.match(updater, /CLIENT_UPDATE_POLICY_URL/);
  assert.match(updater, /CLIENT_CONTROL_URL/);
  assert.match(updater, /ACCOUNT_SESSION_KEY/);
  assert.match(updater, /managed_auto_update_disabled/);
  assert.match(updater, /checkAndMaybeInstall\('admin_sync', chromeApi, \{ force: true \}\)/);
  assert.match(updater, /GPTLOCK_ACCOUNT_REFRESH/);
  assert.match(updater, /ADMIN_UPDATE_GENERATION_KEY/);
  assert.match(updater, /ACCOUNT_SYNC_GENERATION_KEY/);
});
