import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const readRepo = (path) => readFile(new URL('../../' + path, import.meta.url), 'utf8');

test('v0.5.166 retains Astra as the fallback while making the network Work floor configurable', async () => {
  const runtime = await read('tab-feature-runtime.js');
  assert.match(runtime, /DEFAULT_WORK_MODEL = 'gpt-6-astra'/);
  assert.match(runtime, /basePolicy\.workDefaultModel/);
  assert.match(runtime, /prioritizeModels\(\[normalized, normalizedFloor\]\)\[0\] === normalized/);
  assert.match(runtime, /isAtLeastWorkFloor\(selected, floor\) \? selected : floor/);
  assert.doesNotMatch(runtime, /product floor to GPT-5\.6 Sol/);
});


test('Picker A-only discovery keeps native and forced Chat proof without Work discovery', async () => {
  const background = await read('background.js');
  const start = background.indexOf('async function verifyAccountCatalogModels');
  const end = background.indexOf('function modelVerificationHistoryRecord', start);
  const block = background.slice(start, end);
  assert.doesNotMatch(block, /discoverOfficialWorkModels\(tabId, progress\)/);
  assert.doesNotMatch(block, /mergeCatalog\(officialWork\?\.chatCandidates/);
  assert.match(block, /mode: chatCompatibility \? 'picker-a-ui-lock' : 'observe-native'/);
  assert.match(block, /picker_a_chat_lock_queued/);
  assert.doesNotMatch(block, /network_work_catalog_seeded/);
  assert.doesNotMatch(block, /selectorKey: '__work_transport__'/);
});

test('release surfaces remain coherent after v0.5.161', async () => {
  const [manifestText, packageText, background, cargoToml, cargoLock, installer] = await Promise.all([
    read('manifest.json'), read('package.json'), read('background.js'),
    readRepo('native-core/Cargo.toml'), readRepo('native-core/Cargo.lock'),
    readRepo('packaging/windows/GPTWork.iss'),
  ]);
  const version = JSON.parse(manifestText).version;
  const escapedVersion = version.replaceAll('.', '\\.');
  assert.equal(JSON.parse(packageText).version, version);
  assert.match(background, new RegExp(`RUNTIME_CODE_VERSION = '${escapedVersion}'`));
  assert.match(cargoToml, new RegExp(`version = "${escapedVersion}"`));
  assert.match(cargoLock, new RegExp(`name = "gptwork-core"\\nversion = "${escapedVersion}"`));
  assert.match(installer, new RegExp(`#define MyAppVersion "${escapedVersion}"`));
});
