import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ACCOUNT_REFRESH_ALARM,
  ACCOUNT_REFRESH_PERIOD_MINUTES,
  scheduleAccountRefresh,
} from '../account-refresh-scheduler.js';

const ROOT = new URL('../', import.meta.url);
const source = await readFile(new URL('background-update.js', ROOT), 'utf8');

test('release notifications come only from the official GPTWork server', () => {
  assert.match(source, /RELEASE_NOTIFICATION_URL = 'https:\/\/gptlock\.mv3\.cn\/site\/api\/releases\/notifications'/);
  assert.match(source, /AUTO_UPDATE_ALARM_MINUTES = 1/);
  assert.doesNotMatch(source, /api\.github\.com\/repos\/.*releases/);
});

test('background auto-install remains Windows + hardened-core gated', () => {
  const body = source.match(/export function shouldAutoInstall\([^]*?\n\}/)?.[0] || '';
  assert.match(body, /platformOs === 'win'/);
  assert.match(body, /Boolean\(nativeConnected\)/);
  assert.match(body, /supportsReliableWindowsOneClickUpdate\(nativeVersion\)/);
});

test('background updater is the sole persistent update transaction owner', () => {
  assert.match(source, /GPTWORK_UPDATE_STATUS_GET/);
  assert.match(source, /GPTWORK_UPDATE_CHECK/);
  assert.match(source, /GPTWORK_UPDATE_INSTALL/);
  assert.match(source, /phase: 'quiescing'/);
  assert.match(source, /phase: 'installing'/);
  assert.match(source, /phase: 'reloading'/);
  assert.match(source, /phase: 'recovering'/);
  assert.match(source, /phase: 'complete', percent: 100/);
  assert.match(source, /GPTWORK_CONTENT_PREPARE_RELOAD/);
  assert.match(source, /suspendContentRecovery\('update_quiescing'\)/);
  assert.match(source, /recoverOpenTabs\('update_recovery'/);
  assert.match(source, /chromeApi\.runtime\.reload\(\)/);
  assert.match(source, /originalMasterEnabled/);
  assert.match(source, /TRANSIENT_PHASES/);
});

test('100 percent is written only after recovery readiness, never immediately after installer exit', () => {
  const installer = source.match(/async function autoInstallWindows\([^]*?\n\}/)?.[0] || '';
  assert.match(installer, /phase: 'reloading', percent: 82/);
  assert.doesNotMatch(installer, /phase: 'complete'/);
  const recovery = source.match(/async function recoverAfterReload\([^]*?\n\}/)?.[0] || '';
  assert.match(recovery, /runtimeReadiness/);
  assert.match(recovery, /if \(last\.ready\)/);
  assert.match(recovery, /phase: 'complete', percent: 100/);
});

test('a timed-out installed update self-heals once runtime readiness becomes true', () => {
  assert.match(source, /function installedRecoveryErrorCanSelfHeal/);
  assert.match(source, /detail\.includes\('更新已安装但功能恢复超时'\)/);
  assert.match(source, /async function reconcileInstalledRecovery/);
  assert.match(source, /const readiness = await runtimeReadiness\(status\.targetVersion, chromeApi\)/);
  assert.match(source, /if \(!readiness\.ready\) return false/);
  assert.match(source, /phase: 'complete', percent: 100, targetVersion: status\.targetVersion/);
  assert.match(source, /await reconcileInstalledRecovery\(currentVersion, status, chromeApi\)/);
});

test('account control refresh re-arms the shared heartbeat alarm instead of self-messaging', async () => {
  const created = [];
  const chromeApi = {
    storage: { local: { async get() { return { gptworkEnabledLocal: true }; } } },
    alarms: {
      create(name, info) { created.push({ name, info }); },
    },
  };
  const before = Date.now();
  await scheduleAccountRefresh(chromeApi);
  assert.equal(created.length, 1);
  assert.equal(created[0].name, ACCOUNT_REFRESH_ALARM);
  assert.equal(created[0].info.periodInMinutes, ACCOUNT_REFRESH_PERIOD_MINUTES);
  assert.equal(ACCOUNT_REFRESH_PERIOD_MINUTES, 1);
  assert.ok(created[0].info.when >= before);
  assert.ok(created[0].info.when <= Date.now() + 1_000);
  assert.match(source, /await scheduleAccountRefresh\(chromeApi\);/);
  assert.doesNotMatch(source, /runtime\.sendMessage\(message/);
});
