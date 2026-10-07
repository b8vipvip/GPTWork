import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const accountSystem = await readFile(new URL('../account-system-base.mjs', import.meta.url), 'utf8');
const accountClient = await readFile(new URL('../../extension/account-client.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../../extension/background.js', import.meta.url), 'utf8');
const clientControl = await readFile(new URL('../client-control.mjs', import.meta.url), 'utf8');
const adminHtml = await readFile(new URL('../public/admin-models.html', import.meta.url), 'utf8');
const adminJs = await readFile(new URL('../public/admin-models.js', import.meta.url), 'utf8');

test('shared model catalog separates discovery, request confirmation and strict response verification', () => {
  assert.match(accountSystem, /CREATE TABLE IF NOT EXISTS shared_model_catalog/);
  assert.match(accountSystem, /CREATE TABLE IF NOT EXISTS shared_model_catalog_state/);
  assert.match(accountSystem, /CREATE TABLE IF NOT EXISTS shared_model_account_seen/);
  assert.match(accountSystem, /response_confirmed/);
  assert.match(accountSystem, /requestConfirmed = item\?\.requestConfirmed === true/);
  assert.match(accountSystem, /responseConfirmed = item\?\.responseConfirmed === true/);
  assert.match(accountSystem, /request_confirmed_account_count/);
  assert.match(accountSystem, /verified_account_count/);
  assert.match(accountSystem, /s\.response_confirmed=1/);
  assert.match(accountSystem, /verified_count=\(/);
  assert.match(accountSystem, /discovered_count=discovered_count\+1/);
  assert.match(accountSystem, /account_count/);
});

test('catalog generation changes only when the shared catalog surface changes', () => {
  assert.match(accountSystem, /function sharedModelCatalogGeneration/);
  assert.match(accountSystem, /function bumpSharedModelCatalogGeneration/);
  assert.match(accountSystem, /if \(catalogChanged\) bumpSharedModelCatalogGeneration\(\)/);
  assert.match(accountSystem, /updateSharedModelCatalog/);
  assert.match(accountSystem, /deleteSharedModelCatalog/);
  assert.match(clientControl, /modelCatalogGeneration: modelCatalogGeneration\(\)/);
});

test('extension publishes the complete discovered account catalog and syncs by account plus generation', () => {
  assert.match(accountClient, /async function sharedModelCatalog/);
  assert.match(accountClient, /async function publishSharedModels/);
  assert.match(accountClient, /auth: true/);
  assert.match(background, /async function publishAccountModels\(accountCatalog, progress\)/);
  assert.match(background, /for \(const row of accountCatalog\?\.rows \|\| \[\]\)/);
  assert.match(background, /SHARED_MODEL_CATALOG_GENERATION_KEY/);
  assert.match(background, /SHARED_MODEL_CATALOG_ACCOUNT_KEY/);
  assert.match(background, /reason: accountChanged \? 'account_first_login'/);
  assert.match(background, /serverGeneration: lastServerModelCatalogGeneration/);
  assert.doesNotMatch(background, /void syncSharedKnownModels\(\)/);
});

test('admin model management can edit, disable and delete uploaded models', () => {
  assert.match(accountSystem, /\/admin\/api\/account\/model-catalog/);
  assert.match(adminHtml, /<h1>模型管理<\/h1>/);
  assert.match(adminHtml, /账户证据/);
  assert.match(adminHtml, /响应验证账户/);
  assert.match(adminJs, /requestConfirmedAccountCount/);
  assert.match(adminJs, /verifiedAccountCount/);
  assert.match(adminJs, /method:'PUT'/);
  assert.match(adminJs, /method:'DELETE'/);
  assert.match(adminJs, /data-field="enabled"/);
});
