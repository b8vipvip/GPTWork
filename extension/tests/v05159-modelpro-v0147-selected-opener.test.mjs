import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('v0.5.159 Select-model ViewTrack authority remains present after later ModelPro integrations', async () => {
  const [content, source] = await Promise.all([
    r('content.js'),
    r('vendor/modelpro/MODELPRO_SOURCE.json'),
  ]);
  const metadata = JSON.parse(source);
  assert.equal(metadata.repository, 'b8vipvip/ModelPro');
  assert.ok(/^0\.1\.(?:4[7-9]|[5-9]\d)$/.test(metadata.version));
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
});
