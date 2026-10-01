import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const rr = (path) => readFile(new URL('../../' + path, import.meta.url), 'utf8');

test('ModelPro v0.1.50 integration requires row-backed account catalog discovery', async () => {
  const content = await r('content.js');
  const start = content.indexOf('async function discoverAccountModelMetadata()');
  const end = content.indexOf('function diagnosticPerformanceSnapshot', start);
  assert.ok(start >= 0 && end > start);
  const section = content.slice(start, end);
  assert.match(section, /const currentCanJoinCatalog = candidateCount > 0;/);
  assert.doesNotMatch(section, /const currentCanJoinCatalog = !modern\.picker \|\| modern\.rows\.length > 0;/);
  assert.match(section, /Without at least one owned semantic model row there is no selectable account catalog/);
  assert.match(section, /candidateCount = modern\.rows\.length;/);
  assert.match(section, /candidateCount = rows\.length;/);
});

test('zero-row or absent-trigger discovery cannot synthesize a selectable current-page model', async () => {
  const content = await r('content.js');
  const start = content.indexOf('async function discoverAccountModelMetadata()');
  const end = content.indexOf('function diagnosticPerformanceSnapshot', start);
  const section = content.slice(start, end);
  assert.match(section, /modern\.pickerMode !== 'B' && currentCanJoinCatalog && current\?\.model/);
  assert.doesNotMatch(section, /modern\.pickerMode !== 'B' && current\?\.model && !models\.some/);
});

test('v0.5.165 release surfaces are synchronized while the verification-policy seam remains unchanged', async () => {
  const [manifestText, packageText, background, cargoToml, cargoLock, installer, sourceText] = await Promise.all([
    r('manifest.json'), r('package.json'), r('background.js'), rr('native-core/Cargo.toml'),
    rr('native-core/Cargo.lock'), rr('packaging/windows/GPTWork.iss'), r('vendor/modelpro/MODELPRO_SOURCE.json'),
  ]);
  const manifest = JSON.parse(manifestText);
  const pkg = JSON.parse(packageText);
  const source = JSON.parse(sourceText);
  assert.equal(manifest.version, '0.5.165');
  assert.equal(pkg.version, manifest.version);
  assert.match(background, /const RUNTIME_CODE_VERSION = '0\.5\.165';/);
  assert.match(cargoToml, /version = "0\.5\.165"/);
  assert.match(cargoLock, /name = "gptwork-core"\nversion = "0\.5\.165"/);
  assert.match(installer, /#define MyAppVersion "0\.5\.165"/);
  assert.equal(source.version, '0.1.48');
  assert.equal(source.commit, 'e6c53093c726d689065b3c62fb5d8582ebc4ca7c');
  assert.equal(source.blob, '07cffd300731947b9da387b940f8acf1ae830b02');
});
