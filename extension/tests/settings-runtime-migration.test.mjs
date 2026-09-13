import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const entryUrl = new URL('../background-entry.js', import.meta.url);
const migrationUrl = new URL('../settings-migration.js', import.meta.url);
const legacySettingsUrl = new URL('../settings-v0517.html', import.meta.url);

test('service worker migrates already-open legacy settings tabs to the current page', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const [entry, migration] = await Promise.all([
    readFile(entryUrl, 'utf8'),
    readFile(migrationUrl, 'utf8'),
  ]);

  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.background.service_worker, 'background-entry.js');
  assert.equal(manifest.options_ui.page, 'settings-v0521.html');
  assert.match(entry, /import '\.\/settings-migration\.js';/);
  assert.match(entry, /import '\.\/background\.js';/);
  assert.match(migration, /CURRENT_SETTINGS_PAGE = 'settings-v0521\.html'/);
  assert.match(migration, /'settings-v0519\.html'/);
  assert.match(migration, /'settings-v0517\.html'/);
  assert.match(migration, /'options\.html'/);
  assert.match(migration, /chrome\.tabs\.query\(\{\}\)/);
  assert.match(migration, /chrome\.tabs\.update\(tab\.id, \{ url: replacementUrl\(tab\.url\) \}\)/);
  assert.match(migration, /chrome\.runtime\.onInstalled\.addListener\(runMigration\)/);
  assert.match(migration, /chrome\.runtime\.onStartup\.addListener\(runMigration\)/);
  assert.doesNotMatch(migration, /GPTLOCK[_-]LICENSE|licenseKey|licenseCode/);

  await assert.rejects(access(legacySettingsUrl));
});
