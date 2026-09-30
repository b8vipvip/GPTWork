import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readRepo = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('v0.5.149 consumes the exact ModelPro v0.1.46 verification policy seam', async () => {
  const [background, vendor, source] = await Promise.all([
    read('background.js'),
    read('vendor/modelpro/model-verification.js'),
    read('vendor/modelpro/MODELPRO_SOURCE.json'),
  ]);
  const metadata = JSON.parse(source);
  assert.equal(metadata.repository, 'b8vipvip/ModelPro');
  assert.equal(metadata.version, '0.1.46');
  assert.equal(metadata.commit, 'f674411521d54f03682b7c60102a9c21d449f53d');
  assert.equal(metadata.blob, '5ab85559688ed0b605b517e27eec0682361d035c');

  assert.match(vendor, /export function createVerificationCatalog/);
  assert.match(vendor, /export function summarizeVerificationOutcome/);
  assert.match(vendor, /export function createModelVerificationHistoryRecord/);
  assert.match(vendor, /export function shouldRetryTransientResponse/);
  assert.match(vendor, /export function publishableVerificationResults/);

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

test('current release surfaces stay version coherent while the ModelPro v0.1.46 seam remains pinned', async () => {
  const [manifestText, packageText, background, cargoToml, cargoLock, installer] = await Promise.all([
    read('manifest.json'),
    read('package.json'),
    read('background.js'),
    readRepo('native-core/Cargo.toml'),
    readRepo('native-core/Cargo.lock'),
    readRepo('packaging/windows/GPTWork.iss'),
  ]);
  const version = JSON.parse(manifestText).version;
  const escapedVersion = version.replaceAll('.', '\\.');
  assert.equal(JSON.parse(packageText).version, version);
  assert.match(background, new RegExp(`const RUNTIME_CODE_VERSION = '${escapedVersion}';`));
  assert.match(cargoToml, new RegExp(`version = \"${escapedVersion}\"`));
  assert.match(cargoLock, new RegExp(`name = \"gptwork-core\"\\nversion = \"${escapedVersion}\"`));
  assert.match(installer, new RegExp(`#define MyAppVersion \"${escapedVersion}\"`));
});
