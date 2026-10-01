import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const readRepo = (path) => readFile(new URL('../../' + path, import.meta.url), 'utf8');

test('v0.5.161 makes GPT-6 Astra the network Work floor', async () => {
  const runtime = await read('tab-feature-runtime.js');
  assert.match(runtime, /WORK_MODEL_FLOOR = 'gpt-6-astra'/);
  assert.match(runtime, /prioritizeModels\(\[normalized, WORK_MODEL_FLOOR\]\)\[0\] === normalized/);
  assert.match(runtime, /isAtLeastWorkFloor\(selected\) \? selected : WORK_MODEL_FLOOR/);
  assert.match(runtime, /\.filter\(isAtLeastWorkFloor\)/);
  assert.doesNotMatch(runtime, /product floor to GPT-5\.6 Sol/);
});

test('v0.5.161 verifies Work through GPT-6 Astra transport without native Work or Picker B dependency', async () => {
  const background = await read('background.js');
  const start = background.indexOf('async function verifyAccountCatalogModels');
  const end = background.indexOf('function modelVerificationHistoryRecord', start);
  const block = background.slice(start, end);
  assert.match(block, /model: 'gpt-6-astra'/);
  assert.match(block, /selectorKey: '__work_transport__'/);
  assert.match(block, /source: 'network_work_transport'/);
  assert.match(block, /reason: 'network_work_catalog_seeded'/);
  assert.doesNotMatch(block, /sendVerificationReasoningProbe\(tabId, 'work-mode-bootstrap'/);
  assert.doesNotMatch(block, /beginWorkBootstrapTransaction\(tabId, 'post-sol-work-activation'\)/);
});

test('v0.5.161 release surfaces are coherent', async () => {
  const [manifestText, packageText, background, cargoToml, cargoLock, installer] = await Promise.all([
    read('manifest.json'), read('package.json'), read('background.js'),
    readRepo('native-core/Cargo.toml'), readRepo('native-core/Cargo.lock'),
    readRepo('packaging/windows/GPTWork.iss'),
  ]);
  assert.equal(JSON.parse(manifestText).version, '0.5.161');
  assert.equal(JSON.parse(packageText).version, '0.5.161');
  assert.match(background, /RUNTIME_CODE_VERSION = '0\.5\.161'/);
  assert.match(cargoToml, /version = "0\.5\.161"/);
  assert.match(cargoLock, /name = "gptwork-core"\nversion = "0\.5\.161"/);
  assert.match(installer, /#define MyAppVersion "0\.5\.161"/);
});
