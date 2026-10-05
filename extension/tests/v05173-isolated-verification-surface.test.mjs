import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('v0.5.173 exposes a strict verification-surface preflight', async () => {
  const content = await read('content.js');
  assert.match(content, /function verificationSurfaceStatus\(\)/);
  assert.match(content, /contentRuntimeReady: true/);
  assert.match(content, /composerReady/);
  assert.match(content, /modelTriggerReady/);
  assert.match(content, /documentVisible/);
  assert.match(content, /GPTLOCK_VERIFICATION_SURFACE_STATUS/);
  assert.match(content, /ready: structuralReady && documentVisible/);
});

test('v0.5.173 creates one isolated verification execution tab instead of using the owner tab', async () => {
  const background = await read('background.js');
  const runtime = await read('tab-feature-runtime.js');

  assert.match(background, /async function createVerificationExecutionTab\(sourceTabId\)/);
  assert.match(background, /url: 'https:\/\/chatgpt\.com\/'/);
  assert.match(background, /active: false/);
  assert.match(background, /isolateTabForVerification\(verificationTabId\)/);
  assert.match(background, /verification_surface_activation_fallback/);
  assert.match(background, /verification_surface_ready/);
  assert.match(background, /verification_surface_tab_closed/);
  assert.match(runtime, /export async function isolateTabForVerification\(tabId\)/);
  assert.match(runtime, /verification_surface_tab_isolated/);
});

test('v0.5.173 uses the execution tab as request-response authority and mirrors progress to the owner', async () => {
  const background = await read('background.js');
  const verifyStart = background.indexOf('async function autoVerify');
  const verifyEnd = background.indexOf('function diagnosticTabState', verifyStart);
  const body = background.slice(verifyStart, verifyEnd);

  assert.match(body, /const sourceTabId = tabId/);
  assert.match(body, /tabId = session\.verificationTabId/);
  assert.match(body, /state = ensureTabState\(tabId,/);
  assert.match(body, /ownerTabId: sourceTabId/);
  assert.match(background, /async function broadcastVerificationState\(executionTabId, ownerTabId\)/);
  assert.match(background, /await broadcastVerificationState\(tabId, ownerTabId\)/);
  assert.doesNotMatch(body, /verifyAccountCatalogModels\(\s*sourceTabId/);
});

test('v0.5.173 fails fast when the verification surface, core, or monitor is unavailable', async () => {
  const background = await read('background.js');
  const verifyStart = background.indexOf('async function autoVerify');
  const verifyEnd = background.indexOf('function diagnosticTabState', verifyStart);
  const body = background.slice(verifyStart, verifyEnd);

  assert.match(body, /verification_surface_unavailable/);
  assert.match(body, /verification_core_unavailable/);
  assert.match(body, /verification_network_monitor_unavailable/);
  assert.match(body, /auto_verify_infrastructure_failed/);
  const preflightAt = body.indexOf("verification_surface_unavailable");
  const catalogAt = body.indexOf('accountCatalog = await discoverAccountCatalog(tabId)');
  assert.ok(preflightAt >= 0 && catalogAt > preflightAt, 'surface preflight must complete before catalog execution');
});

test('v0.5.173 never publishes shared model results when zero requests were confirmed', async () => {
  const background = await read('background.js');
  const verifyStart = background.indexOf('async function autoVerify');
  const verifyEnd = background.indexOf('function diagnosticTabState', verifyStart);
  const body = background.slice(verifyStart, verifyEnd);

  assert.match(body, /if \(catalogVerification\.requestConfirmed > 0\) \{/);
  assert.match(body, /shared_model_catalog_publish_skipped/);
  assert.match(body, /reason: 'zero_request_confirmed'/);
  assert.match(body, /verification_infrastructure_no_requests_confirmed/);
  assert.match(body, /autoVerification\.infrastructureFailure = true/);
});

test('v0.5.173 keeps native Picker-B discovery separate from the verification execution tab', async () => {
  const background = await read('background.js');
  assert.match(background, /discoverNativeWorkCandidates\(tabId, progress\)/);
  assert.match(background, /native_work_catalog_discovery_temp_tab_created/);
  assert.match(background, /verification_surface_tab_created/);
  assert.match(background, /isolateTabForNativeDiscovery\(discoveryTabId\)/);
  assert.match(background, /isolateTabForVerification\(verificationTabId\)/);
});
