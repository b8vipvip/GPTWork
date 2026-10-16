import assert from 'node:assert/strict';
import test from 'node:test';
import { isUpdaterReady } from '../update-manager.mjs';

const healthy = {
  serviceInstalled: true,
  watcherInstalled: true,
  watcherActive: true,
  watcherEnabled: true,
};

test('systemd updater is ready when both on-demand executor and active watcher exist', () => {
  assert.equal(isUpdaterReady(healthy), true);
});

test('watcher alone cannot accept updates if the executor service is missing', () => {
  assert.equal(isUpdaterReady({ ...healthy, serviceInstalled: false }), false);
});

test('installed but inactive watcher cannot accept updates', () => {
  assert.equal(isUpdaterReady({ ...healthy, watcherActive: false }), false);
});

test('disabled watcher cannot accept updates', () => {
  assert.equal(isUpdaterReady({ ...healthy, watcherEnabled: false }), false);
});

test('watcher unit must be installed', () => {
  assert.equal(isUpdaterReady({ ...healthy, watcherInstalled: false }), false);
});

test('test-only bypass remains explicit and restores readiness', () => {
  assert.equal(isUpdaterReady({
    serviceInstalled: false, watcherInstalled: false,
    watcherActive: false, watcherEnabled: false,
    allowWithoutSystemd: true,
  }), true);
});
