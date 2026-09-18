import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ACCOUNT_REFRESH_ALARM,
  scheduleAccountRefresh,
} from '../account-refresh-scheduler.js';

const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const backgroundEntry = fs.readFileSync(new URL('../background-entry.js', import.meta.url), 'utf8');

test('native runtime cannot connect or reconnect while master is off', () => {
  assert.match(background, /function masterRuntimeEnabled\(\)/);
  assert.match(background, /async function masterStorageEnabled\(\)/);
  const connect = background.match(/function connectNative\(\) \{([\s\S]*?)\n\}/)?.[0] || '';
  assert.match(connect, /if \(!masterRuntimeEnabled\(\)\)/);
  assert.match(connect, /MASTER_DISABLED/);
  assert.match(background, /async function scheduleReconnect\(\) \{\s*if \(!await masterStorageEnabled\(\)\) return false;/);
  assert.match(background, /if \(policyChanged && masterRuntimeEnabled\(\)\)/);
});

test('master-off background shutdown solely owns native, alarms, debugger and badge cleanup', () => {
  const stop = background.match(/async function stopBackgroundRuntime\([^)]*\) \{([\s\S]*?)\n\}/)?.[0] || '';
  assert.match(stop, /nativePort = null/);
  assert.match(stop, /chrome\.alarms\.clear\(RECONNECT_ALARM\)/);
  assert.match(stop, /chrome\.alarms\.clear\(ACCOUNT_REFRESH_ALARM\)/);
  assert.match(stop, /networkMonitor\.detach\(tabId\)/);
  assert.match(stop, /setBadgeText\(\{ tabId, text: '' \}\)/);
  assert.doesNotMatch(backgroundEntry, /master-runtime-safety\.js/);
  assert.doesNotMatch(background, /chrome\.runtime\.connectNative\s*=/);
});

test('browser-wide debugger configuration is serialized and initialization is single-flight', () => {
  const configure = background.match(/async function configureOpenTabs\(\) \{([\s\S]*?)\n\}/)?.[0] || '';
  assert.match(configure, /for \(const tab of tabs\) await configureTab\(tab\)/);
  assert.doesNotMatch(configure, /^\s*(?:await\s+)?Promise\.all\(/m);
  assert.match(background, /let initializeTask = null/);
  assert.match(background, /if \(initializeTask\) return initializeTask/);
  assert.match(background, /performInitialize\(\)\.finally/);
  assert.match(background, /async function initializeAfterCurrentTask\(\{ refreshMasterFromStorage = false \} = \{\}\)/);
  assert.match(background, /refreshMasterRuntimeStateFromStorage/);
  assert.match(background, /const current = initializeTask/);
  assert.match(background, /try \{ await current; \} catch \{\}/);
  assert.match(background, /if \(!masterRuntimeEnabled\(\)\) return;/);
  assert.match(background, /if \(masterRuntimeEnabled\(\)\) void initializeAfterCurrentTask\(\)/);
});

test('account heartbeat scheduler refuses to re-arm after master is disabled', async () => {
  const created = [];
  const cleared = [];
  const chromeApi = {
    storage: {
      local: {
        async get() {
          return { gptworkEnabledLocal: false };
        },
      },
    },
    alarms: {
      async create(name, info) {
        created.push({ name, info });
      },
      async clear(name) {
        cleared.push(name);
        return true;
      },
    },
  };
  const scheduled = await scheduleAccountRefresh(chromeApi);
  assert.equal(scheduled, false);
  assert.deepEqual(created, []);
  assert.deepEqual(cleared, [ACCOUNT_REFRESH_ALARM]);
});
