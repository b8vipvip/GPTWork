import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('legacy License stays removed while user-level window quota gates GPTWork', async () => {
  const [background, auth, accountSystem, manifestText] = await Promise.all([
    readFile(new URL('../background.js', import.meta.url), 'utf8'),
    readFile(new URL('../auth-gate.js', import.meta.url), 'utf8'),
    readFile(new URL('../../license-server/account-system.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  const settings = await readFile(new URL(`../${manifest.options_ui.page}`, import.meta.url), 'utf8');
  assert.equal(manifest.options_ui.page, 'settings-v0521.html');
  assert.doesNotMatch(settings, /授权验证 \/ License|id="licenseCode"|GPTL-/);
  const gate = background.match(/function accountAllowsState\([^)]*\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(gate, /authenticated/);
  assert.match(gate, /windowId/);
  assert.match(gate, /allowedWindowKeys/);
  assert.match(gate, /deniedWindowKeys/);
  assert.match(background, /authorized: false,[\s\S]*status: 'removed',[\s\S]*license: null/);
  assert.match(auth, /当前等级最多 .*同时窗口/);
  assert.match(accountSystem, /const remaining = Math\.max\(0, Number\(entitlement\.limits\.windows \|\| 1\) - occupiedByOtherSessions\);/);
  assert.match(accountSystem, /const allowed = entitlement\.active \? requested\.slice\(0, remaining\) : \[\];/);
});
