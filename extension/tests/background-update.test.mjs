import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ACCOUNT_REFRESH_ALARM,
  AUTO_UPDATE_ALARM_MINUTES,
  RELEASE_NOTIFICATION_URL,
  releaseNotificationUrl,
  scheduleAccountRefresh,
  shouldAutoInstall,
} from '../background-update.js';

const ROOT = new URL('../', import.meta.url);

test('release notifications come only from the official GPTWork server', () => {
  assert.equal(RELEASE_NOTIFICATION_URL, 'https://gptlock.mv3.cn/site/api/releases/notifications');
  const url = new URL(releaseNotificationUrl('generation-123', 20_000));
  assert.equal(url.origin, 'https://gptlock.mv3.cn');
  assert.equal(url.pathname, '/site/api/releases/notifications');
  assert.equal(url.searchParams.get('since'), 'generation-123');
  assert.equal(url.searchParams.get('wait'), '20000');
  assert.equal(AUTO_UPDATE_ALARM_MINUTES, 1);
});

test('background auto-install is limited to Windows with a hardened connected core', () => {
  assert.equal(shouldAutoInstall({ platformOs: 'win', nativeConnected: true, nativeVersion: '0.5.24' }), true);
  assert.equal(shouldAutoInstall({ platformOs: 'win', nativeConnected: true, nativeVersion: '0.5.29' }), true);
  assert.equal(shouldAutoInstall({ platformOs: 'win', nativeConnected: false, nativeVersion: '0.5.29' }), false);
  assert.equal(shouldAutoInstall({ platformOs: 'win', nativeConnected: true, nativeVersion: '0.5.23' }), false);
  assert.equal(shouldAutoInstall({ platformOs: 'linux', nativeConnected: true, nativeVersion: '1.0.0' }), false);
});

test('account control refresh re-arms the shared heartbeat alarm instead of self-messaging', async () => {
  const created = [];
  const chromeApi = {
    alarms: {
      create(name, info) {
        created.push({ name, info });
      },
    },
  };
  const before = Date.now();
  await scheduleAccountRefresh(chromeApi);
  assert.equal(created.length, 1);
  assert.equal(created[0].name, ACCOUNT_REFRESH_ALARM);
  assert.equal(created[0].info.periodInMinutes, AUTO_UPDATE_ALARM_MINUTES);
  assert.ok(created[0].info.when >= before);
  assert.ok(created[0].info.when <= Date.now() + 1_000);

  const source = await readFile(new URL('background-update.js', ROOT), 'utf8');
  assert.match(source, /await scheduleAccountRefresh\(chromeApi\);/);
  assert.doesNotMatch(source, /runtime\.sendMessage\(message/);
});
