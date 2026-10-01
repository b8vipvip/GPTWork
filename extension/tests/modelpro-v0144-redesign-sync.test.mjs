import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('current GPTWork version ports live-validated ModelPro v0.1.44 redesign authority', async () => {
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
  assert.match(network, /defaultModel: evidence\.defaultModel/);
  assert.match(background, /__work_transport__/);
  assert.match(background, /network_work_catalog_seeded/);
  assert.match(background, /source: 'network_work_transport'/);
  for (const model of ['gpt-5.6-luna','gpt-5.6-terra','gpt-6-astra','gpt-6-luna','gpt-6-sol']) {
    assert.ok(background.includes(model));
  }
});
