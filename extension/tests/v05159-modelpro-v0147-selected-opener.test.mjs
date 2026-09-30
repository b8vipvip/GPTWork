import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('v0.5.159 consumes ModelPro v0.1.47 and preserves exact Select-model ViewTrack authority', async () => {
  const [content, source, manifestText, packageText, background] = await Promise.all([
    r('content.js'),
    r('vendor/modelpro/MODELPRO_SOURCE.json'),
    r('manifest.json'),
    r('package.json'),
    r('background.js'),
  ]);
  const metadata = JSON.parse(source);
  assert.equal(metadata.version, '0.1.47');
  assert.equal(metadata.commit, '8a6d468b52ccba7395b56ac3c243773e3a420c8b');
  assert.equal(metadata.blob, '5ab85559688ed0b605b517e27eec0682361d035c');

  const openerStart = content.indexOf('function redesignedModelViewOpener(picker)');
  const openerEnd = content.indexOf('function isModelListScope(scope)', openerStart);
  assert.ok(openerStart >= 0 && openerEnd > openerStart);
  const opener = content.slice(openerStart, openerEnd);
  assert.match(opener, /exactModelViewName/);
  assert.match(opener, /选择模型/);
  assert.match(opener, /exactModelViewName\.test\(accessibleName\)/);
  assert.ok(
    opener.indexOf('exactModelViewName.test(accessibleName)') < opener.indexOf('const descriptor = rowModelDescriptor(element)'),
    'stable accessible Select-model identity must win before 5.5 高 is parsed as a model row',
  );

  const navStart = content.indexOf('const modelViewOpener = redesignedModelViewOpener(picker)');
  const navEnd = content.indexOf('const initialOpener = modelSubmenuOpener(picker)', navStart);
  assert.ok(navStart >= 0 && navEnd > navStart);
  const navigation = content.slice(navStart, navEnd);
  assert.match(navigation, /picker-redesign-model-view-unresolved/);
  assert.match(navigation, /return \{ trigger, picker, opener: modelViewOpener, submenu: null, rows: \[\], pageContext, pickerMode: 'A' \};/);

  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.version, '0.5.159');
  assert.equal(JSON.parse(packageText).version, manifest.version);
  assert.match(background, /const RUNTIME_CODE_VERSION = '0\.5\.159';/);
});
