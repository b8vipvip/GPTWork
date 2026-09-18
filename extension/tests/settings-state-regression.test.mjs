import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const optionsUrl = new URL('../options.js', import.meta.url);
const featureControllerUrl = new URL('../feature-toggle-controller.js', import.meta.url);
const settingsShellUrl = new URL('../settings-shell.js', import.meta.url);
const migrationUrl = new URL('../settings-migration.js', import.meta.url);
const masterUiUrl = new URL('../master-ui-controller.js', import.meta.url);

test('current settings expose master, tab-scoped Work, and compact model lock editor', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const settingsPageUrl = new URL(`../${manifest.options_ui.page}`, import.meta.url);
  const [settingsHtml, options, featureController, shell, migration, masterUi] = await Promise.all([
    readFile(settingsPageUrl, 'utf8'),
    readFile(optionsUrl, 'utf8'),
    readFile(featureControllerUrl, 'utf8'),
    readFile(settingsShellUrl, 'utf8'),
    readFile(migrationUrl, 'utf8'),
    readFile(masterUiUrl, 'utf8'),
  ]);

  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.options_ui.page, 'settings-v0521.html');
  assert.match(settingsHtml, /<input\b(?=[^>]*\bid="enabled")(?=[^>]*\btype="checkbox")[^>]*>/);
  assert.doesNotMatch(settingsHtml, /id="enabled"[^>]*hidden/);
  assert.match(settingsHtml, /data-gptwork-settings-master="true"/);
  assert.match(settingsHtml, /<input\b(?=[^>]*\bid="workModeEnabled")(?=[^>]*\btype="checkbox")[^>]*>/);
  assert.doesNotMatch(settingsHtml, /id="modelLockEnabled"/);
  assert.match(settingsHtml, /id="lockEditorToggle"/);
  assert.match(settingsHtml, /按 ChatGPT 标签页隔离/);
  assert.match(settingsHtml, /按 ChatGPT 标签页隔离/);
  assert.match(settingsHtml, /<script type="module" src="feature-toggle-controller\.js"><\/script>/);
  assert.doesNotMatch(settingsHtml, /settings-enabled-guard\.js/);
  assert.doesNotMatch(settingsHtml, /enabled-toggle-controller\.js/);

  assert.match(featureController, /GPTWORK_TAB_FEATURE_GET/);
  assert.match(featureController, /GPTWORK_TAB_FEATURE_SET/);
  assert.match(featureController, /active:\s*true, currentWindow:\s*true/);
  assert.match(featureController, /exact tabId, never windowId/);
  assert.doesNotMatch(featureController, /function requireActivation|requireActivation\(currentAccount\)/);
  assert.doesNotMatch(featureController, /GPTLOCK_SET_ENABLED/);
  assert.doesNotMatch(featureController, /gptworkWorkModeEnabled/);
  assert.doesNotMatch(featureController, /gptworkModelLockEnabled/);

  assert.match(masterUi, /GPTWORK_MASTER_STATUS/);
  assert.match(masterUi, /GPTWORK_MASTER_SET/);
  assert.match(masterUi, /extension-page-runtime\.js/);
  assert.match(masterUi, /event\.stopImmediatePropagation\(\)/);
  assert.doesNotMatch(options, /patchSettings\(\{ enabled: target\.checked \}\)/);
  assert.doesNotMatch(options, /elements\.save\.addEventListener/);
  assert.match(options, /if \(elements\.networkVerification\)/);
  assert.match(options, /if \(elements\.autoAlignSelection\)/);
  assert.doesNotMatch(options, /\n\s*elements\.networkVerification\.checked = settings\.networkVerificationEnabled;/);
  assert.doesNotMatch(options, /\n\s*elements\.autoAlignSelection\.checked = settings\.autoAlignSelection;/);

  assert.match(shell, /UPDATE_STATUS_KEY = 'gptlockUiUpdateStatus'/);
  assert.match(shell, /SAFE_CORE_RECONCILE_PHASES = new Set\(\['idle', 'checking', 'ready', 'up_to_date', 'error'\]\)/);
  assert.match(shell, /state\?\.nativeStatus\?\.connected \? state\.nativeStatus\.version : null/);
  assert.match(shell, /coreNode\.textContent = nativeVersion/);
  assert.match(shell, /nativeVersion,\n        coreVersionReconciledAt/);
  assert.match(shell, /chrome\.storage\.onChanged\.addListener/);

  assert.match(migration, /CURRENT_SETTINGS_PAGE = 'settings-v0521\.html'/);
  assert.match(migration, /'settings-v0519\.html'/);
  assert.doesNotMatch(migration, /GPTLOCK[_-]LICENSE/);
});
