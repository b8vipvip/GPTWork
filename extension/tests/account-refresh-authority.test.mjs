import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const scheduler = fs.readFileSync(new URL('../account-refresh-scheduler.js', import.meta.url), 'utf8');
const featureRuntime = fs.readFileSync(new URL('../tab-feature-runtime.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const backgroundUpdate = fs.readFileSync(new URL('../background-update.js', import.meta.url), 'utf8');

test('account refresh has one alarm scheduler and no service-worker self message', () => {
  assert.match(scheduler, /export const ACCOUNT_REFRESH_ALARM = 'gptlock-account-refresh'/);
  assert.match(scheduler, /export async function scheduleAccountRefresh/);
  assert.match(featureRuntime, /import \{ scheduleAccountRefresh \} from '\.\/account-refresh-scheduler\.js'/);
  assert.doesNotMatch(featureRuntime, /runtimeMessage\(\{ type: 'GPTLOCK_ACCOUNT_REFRESH'/);
  assert.doesNotMatch(featureRuntime, /refreshBackgroundRuntime/);
  assert.match(background, /import \{ ACCOUNT_REFRESH_ALARM \} from '\.\/account-refresh-scheduler\.js'/);
  assert.doesNotMatch(background, /const ACCOUNT_REFRESH_ALARM = 'gptlock-account-refresh'/);
  assert.match(backgroundUpdate, /import \{ ACCOUNT_REFRESH_ALARM, scheduleAccountRefresh \} from '\.\/account-refresh-scheduler\.js'/);
  assert.doesNotMatch(backgroundUpdate, /export async function scheduleAccountRefresh/);
  const literalCount = [scheduler, featureRuntime, background, backgroundUpdate]
    .reduce((count, source) => count + (source.match(/gptlock-account-refresh/g) || []).length, 0);
  assert.equal(literalCount, 1);
});
