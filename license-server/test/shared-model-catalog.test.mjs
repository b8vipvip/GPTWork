import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const accountSystem = await readFile(new URL('../account-system-base.mjs', import.meta.url), 'utf8');
const accountClient = await readFile(new URL('../../extension/account-client.js', import.meta.url), 'utf8');

test('shared model catalog is authenticated and stores only request-confirmed hints', () => {
  assert.match(accountSystem, /CREATE TABLE IF NOT EXISTS shared_model_catalog/);
  assert.match(accountSystem, /\/api\/v1\/account\/model-catalog/);
  assert.match(accountSystem, /requireSession\(req\)/);
  assert.match(accountSystem, /item\?\.requestConfirmed !== true/);
  assert.match(accountSystem, /verified_count=shared_model_catalog\.verified_count\+1/);
});

test('extension can fetch and publish shared model metadata through its account session', () => {
  assert.match(accountClient, /async function sharedModelCatalog/);
  assert.match(accountClient, /async function publishSharedModels/);
  assert.match(accountClient, /auth: true/);
});
