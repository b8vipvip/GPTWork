import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');


test('current GPTWork keeps ModelPro redesign authority while using source-first Work discovery', async () => {
  const [background, content, network, evidence, recovery, manifestText, packageText] = await Promise.all([
    r('background.js'), r('content.js'), r('network-monitor.js'), r('page-model-evidence.js'),
    r('content-runtime-recovery.js'), r('manifest.json'), r('package.json'),
  ]);
  const manifest = JSON.parse(manifestText);
  const pkg = JSON.parse(packageText);
  assert.equal(manifest.version, pkg.version);
  assert.match(manifest.version, /^0\.5\.\d+$/);
  assert.ok(background.includes(`const RUNTIME_CODE_VERSION = '${manifest.version}'`));
  assert.ok(manifest.content_scripts[0].js.includes('composer-send-compat.js'));
  assert.match(recovery, /'composer-send-compat\.js'/);
  assert.match(content, /picker-mode-a-redesigned-direct-chat-list/);
  assert.match(content, /verification_model_selection_deferred_to_network/);
  assert.match(evidence, /composer-redesign-default-sol/);
  assert.match(evidence, /open-picker-default-sol/);
  assert.match(network, /Network\.streamResourceContent/);
  assert.match(network, /initial_conversation_aborted/);
  assert.match(background, /async function discoverOfficialWorkModels/);
  assert.match(background, /__picker_b_chat_lock__/);
  assert.match(background, /official-work-picker-b/);
  assert.doesNotMatch(background, /network_work_catalog_seeded/);
});
