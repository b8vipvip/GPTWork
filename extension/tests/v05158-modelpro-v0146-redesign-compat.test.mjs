import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  publishableVerificationResults,
  shouldRetryTransientResponse,
} from '../vendor/modelpro/model-verification.js';

const r = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('ViewTrack and transient-response compatibility remains present after v0.5.158', async () => {
  const [background, content, vendor, source, manifestText, packageText] = await Promise.all([
    r('background.js'), r('content.js'), r('vendor/modelpro/model-verification.js'),
    r('vendor/modelpro/MODELPRO_SOURCE.json'), r('manifest.json'), r('package.json'),
  ]);
  const metadata = JSON.parse(source);
  assert.equal(metadata.repository, 'b8vipvip/ModelPro');
  assert.ok(/^0\.1\.(?:4[6-9]|[5-9]\d)$/.test(metadata.version));
  assert.equal(metadata.blob, '5ab85559688ed0b605b517e27eec0682361d035c');
  assert.match(vendor, /export function shouldRetryTransientResponse/);
  assert.match(vendor, /export function publishableVerificationResults/);
  assert.match(content, /function interactionVisible\(element\)/);
  assert.match(content, /function defaultChatDirectModelRows\(picker, \{ requireInteraction = true \} = \{\}\)/);
  assert.match(content, /const rows = requireInteraction \? semanticRows\.filter\(interactionVisible\) : semanticRows;/);
  assert.match(content, /function redesignedModelViewOpener\(picker\)/);
  assert.match(content, /model-picker-redesign-model-view/);
  assert.match(content, /invalidated_after_debugger_attach/);
  assert.match(background, /account_model_verification_transient_response_retry/);
  assert.match(background, /shouldRetryTransientResponse\(result, \{ maxRetries: 1 \}\)/);
  assert.match(background, /publishableVerificationResults\(progress\?\.results, normalizeConcreteModelId\)/);
  const manifest = JSON.parse(manifestText);
  assert.equal(JSON.parse(packageText).version, manifest.version);
  const escapedVersion = manifest.version.replaceAll('.', '\\.');
  assert.match(background, new RegExp(`const RUNTIME_CODE_VERSION = '${escapedVersion}';`));
});

test('one request-confirmed canceled HTTP 200 turn is retried once and never shared unverified', () => {
  const canceled = {
    model: 'gpt-6-luna',
    verified: false,
    requestConfirmed: true,
    responseConfirmed: false,
    responseHttpStatus: 200,
    responseBodyError: 'net::ERR_ABORTED',
    responseIssue: 'response_body_read_failed',
    retryCount: 0,
  };
  assert.equal(shouldRetryTransientResponse(canceled, { maxRetries: 1 }), true);
  assert.equal(shouldRetryTransientResponse({ ...canceled, retryCount: 1 }, { maxRetries: 1 }), false);
  assert.deepEqual(publishableVerificationResults([canceled], (value) => value), []);

  const verified = {
    ...canceled,
    model: 'gpt-6-sol',
    verified: true,
    responseConfirmed: true,
    responseBodyError: null,
    responseIssue: null,
  };
  assert.deepEqual(publishableVerificationResults([canceled, verified], (value) => value), [verified]);
});
