import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readRepo = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('v0.5.149 consumes the exact ModelPro v0.1.45 verification policy seam', async () => {
  const [background, vendor, source] = await Promise.all([
    read('background.js'),
    read('vendor/modelpro/model-verification.js'),
    read('vendor/modelpro/MODELPRO_SOURCE.json'),
  ]);
  const metadata = JSON.parse(source);
  assert.equal(metadata.repository, 'b8vipvip/ModelPro');
  assert.equal(metadata.version, '0.1.45');
  assert.equal(metadata.commit, '33bc784dbf91c52aa1776ee46550acb2dcf04c8b');
  assert.equal(metadata.blob, 'b7a070a4aeec86b4cb7e0c4ec4dc4750b4e2e215');

  assert.match(vendor, /export function createVerificationCatalog/);
  assert.match(vendor, /export function summarizeVerificationOutcome/);
  assert.match(vendor, /export function createModelVerificationHistoryRecord/);

  assert.match(background, /from '\.\/vendor\/modelpro\/model-verification\.js'/);
  assert.match(background, /createVerificationCatalog\(\{/);
  assert.match(background, /normalizeModel: normalizeConcreteModelId/);
  assert.match(background, /state\.autoVerification\.catalogVerification = progress/);
  assert.doesNotMatch(background, /const catalogIdentity = \(/);
  assert.doesNotMatch(background, /const verificationChronology = \(/);
  assert.match(background, /summarizeVerificationOutcome\(catalogVerification\)/);
  assert.match(background, /createModelVerificationHistoryRecord\(tabId, autoVerification, \{/);
  assert.match(background, /reportType: 'gptwork-model-verification-report'/);
});

test('v0.5.149 release surfaces stay version coherent', async () => {
  const [manifestText, packageText, background, cargoToml, cargoLock, installer] = await Promise.all([
    read('manifest.json'),
    read('package.json'),
    read('background.js'),
    readRepo('native-core/Cargo.toml'),
    readRepo('native-core/Cargo.lock'),
    readRepo('packaging/windows/GPTWork.iss'),
  ]);
  assert.equal(JSON.parse(manifestText).version, '0.5.149');
  assert.equal(JSON.parse(packageText).version, '0.5.149');
  assert.match(background, /const RUNTIME_CODE_VERSION = '0\.5\.149';/);
  assert.match(cargoToml, /version = "0\.5\.149"/);
  assert.match(cargoLock, /name = "gptwork-core"\nversion = "0\.5\.149"/);
  assert.match(installer, /#define MyAppVersion "0\.5\.149"/);
});
