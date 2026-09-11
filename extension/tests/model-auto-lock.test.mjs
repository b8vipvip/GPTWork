import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../model-auto-lock.js', import.meta.url), 'utf8');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadHarness({ workModeEnabled = false, modelLockEnabled = false } = {}) {
  let listener = null;
  const store = {
    policy: {
      lockedModels: ['gpt-5.6-sol'],
      allowedReasoningLevels: ['medium', 'high', 'extra-high'],
      strictMode: true,
    },
    gptworkModelLockSelection: ['gpt-5.6-sol'],
    discoveredModels: ['gpt-5.6-sol'],
  };
  const localStore = {
    gptworkWorkModeEnabled: workModeEnabled,
    gptworkModelLockEnabled: modelLockEnabled,
  };
  const pick = (sourceStore, keys) => {
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, clone(sourceStore[key])]));
    return { [keys]: clone(sourceStore[keys]) };
  };
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          return pick(localStore, keys);
        },
      },
      sync: {
        async get(keys) {
          return pick(store, keys);
        },
        async set(patch) {
          Object.assign(store, clone(patch));
        },
      },
      onChanged: {
        addListener(callback) {
          listener = callback;
        },
      },
    },
  };
  vm.runInContext(source, vm.createContext({ chrome }));
  return { store, emit: (...args) => listener(...args) };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('new discovered models do not mutate lock policy while both features are off', async () => {
  const { store, emit } = loadHarness();
  store.discoveredModels = ['gpt-5.6-sol', 'gpt-5.7-sol'];
  emit({ discoveredModels: { oldValue: ['gpt-5.6-sol'], newValue: ['gpt-5.6-sol', 'gpt-5.7-sol'] } }, 'sync');
  await flush();
  assert.deepEqual(store.policy.lockedModels, ['gpt-5.6-sol']);
  assert.deepEqual(store.gptworkModelLockSelection, ['gpt-5.6-sol']);
});

test('Work mode locks Sol, Astra and newly discovered GPT-5.6+ models', async () => {
  const { store, emit } = loadHarness({ workModeEnabled: true });
  store.discoveredModels = ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.7-sol'];
  emit({ discoveredModels: { oldValue: ['gpt-5.6-sol'], newValue: ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.7-sol'] } }, 'sync');
  await flush();
  assert.deepEqual(store.policy.lockedModels, ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.7-sol']);
});

test('Model lock alone keeps the explicit checked list when a new model is discovered', async () => {
  const { store, emit } = loadHarness({ modelLockEnabled: true });
  store.discoveredModels = ['gpt-5.6-sol', 'gpt-5.7-sol'];
  emit({ discoveredModels: { oldValue: ['gpt-5.6-sol'], newValue: ['gpt-5.6-sol', 'gpt-5.7-sol'] } }, 'sync');
  await flush();
  assert.deepEqual(store.gptworkModelLockSelection, ['gpt-5.6-sol']);
  assert.deepEqual(store.policy.lockedModels, ['gpt-5.6-sol']);
});

test('combined mode adds new GPT-5.6+ models through Work without changing Model-lock checks', async () => {
  const { store, emit } = loadHarness({ workModeEnabled: true, modelLockEnabled: true });
  store.gptworkModelLockSelection = ['gpt-5.5'];
  store.discoveredModels = ['gpt-5.6-sol', 'gpt-5.7-sol'];
  emit({ discoveredModels: { oldValue: ['gpt-5.6-sol'], newValue: ['gpt-5.6-sol', 'gpt-5.7-sol'] } }, 'sync');
  await flush();
  assert.deepEqual(store.gptworkModelLockSelection, ['gpt-5.5']);
  assert.deepEqual(store.policy.lockedModels, ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.7-sol', 'gpt-5.5']);
});
