import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { extractResponseEvidence } from '../network-evidence.js';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('v0.5.174 server Work feature gate is delivered and enforced across client runtime surfaces', async () => {
  const server = await read('../license-server/client-control.mjs');
  const adminHtml = await read('../license-server/public/admin-client-settings.html');
  const adminJs = await read('../license-server/public/admin-client-settings.js');
  const background = await read('background.js');
  const runtime = await read('tab-feature-runtime.js');
  const controller = await read('work-mode-controller.js');
  const featureUi = await read('feature-toggle-controller.js');
  const popup = await read('popup-v0513.html');
  const settings = await read('settings-v0521.html');
  const policy = await read('policy.js');

  assert.match(server, /work_mode_feature_enabled/);
  assert.match(server, /workModeFeatureEnabled/);
  assert.match(adminHtml, /clientWorkModeFeature/);
  assert.match(adminJs, /workModeFeatureEnabled:el\.workFeature\.checked/);

  assert.match(background, /workModeFeatureEnabled: remote\.workModeFeatureEnabled !== false/);
  assert.match(background, /async function discoverOfficialWorkModels/);
  assert.doesNotMatch(background, /official_work_model_discovery_skipped[\s\S]{0,160}work_feature_disabled/);

  assert.match(runtime, /WORK_FEATURE_DISABLED/);
  assert.match(runtime, /if \(workFeatureEnabled && feature\.workModeEnabled\)/);
  assert.match(runtime, /work_feature_availability_changed/);
  assert.match(controller, /workModeFeatureEnabled/);
  assert.match(controller, /if \(!workModeFeatureEnabled\)/);

  assert.match(policy, /workModeFeatureEnabled: typeof source\.workModeFeatureEnabled === 'boolean'/);
  assert.match(featureUi, /let workFeatureAvailable = false/);
  assert.match(featureUi, /\[data-work-feature\]/);
  assert.match(featureUi, /setWorkFeatureAvailable/);
  assert.match(controller, /let workModeFeatureEnabled = false/);
  assert.match(popup, /data-work-feature hidden/);
  assert.match(settings, /data-work-feature hidden/);
});

test('v0.5.174 discovers a future official model tier without server pre-registration', async () => {
  const pageEvidenceSource = await read('page-model-evidence.js');
  const context = vm.createContext({});
  vm.runInContext(pageEvidenceSource, context);
  const adapter = context.__GPTLOCK_PAGE_MODEL_EVIDENCE__;

  assert.equal(adapter.modelFromText('GPT-7 Nova'), 'gpt-7-nova');
  assert.equal(adapter.modelFromText('GPT 8 Orion'), 'gpt-8-orion');
  assert.notEqual(adapter.modelFromText('GPT-5.5 Leaving on October 14'), 'gpt-5.5-leaving');

  const content = await read('content.js');
  const server = await read('../license-server/account-system-base.mjs');
  assert.match(content, /data-model-id/);
  assert.match(content, /Future official model tiers must be discoverable before the server knows them/);
  assert.match(server, /\^\[a-z0-9\._:-\]\{1,128\}\$/);
  assert.match(server, /mergeSharedModelCatalog/);
});

test('v0.5.174 response confirmation cannot be fabricated from Work default/profile metadata', async () => {
  const background = await read('background.js');
  const network = await read('network-evidence.js');

  assert.doesNotMatch(background, /work_profile_confirmed_by_default_model_slug/);
  assert.match(background, /Only a directly observed network response field/);
  assert.match(network, /default_model_slug is routing\/profile metadata, never served-model proof/);

  const evidence = extractResponseEvidence({
    body: JSON.stringify({
      message: {
        metadata: {
          resolved_model_slug: 'gpt-5-6',
          default_model_slug: 'gpt-6-astra-wm',
          thinking_effort: 'high',
        },
      },
    }),
    mimeType: 'application/json',
  });
  assert.equal(evidence.model, 'gpt-5.6');
  assert.equal(evidence.rawModel, 'gpt-5.6');
  assert.equal(evidence.defaultModel, 'gpt-6-astra');
  assert.equal(evidence.rawDefaultModel, 'gpt-6-astra-wm');
});

test('v0.5.174 native Work discovery requires actual selected-state confirmation', async () => {
  const content = await read('content.js');
  const background = await read('background.js');

  assert.match(content, /function workControlSelected\(control\)/);
  assert.match(content, /reason: 'work_control_confirmed'/);
  assert.match(content, /reason: 'work_control_not_confirmed'/);
  assert.match(background, /response\?\.confirmed === true/);
  assert.doesNotMatch(background, /entered: response\?\.ok === true && \(response\?\.attempted === true/);
});
