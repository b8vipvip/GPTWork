import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const repair = fs.readFileSync(new URL('../../packaging/windows/Repair-GPTWork.ps1', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../../packaging/windows/GPTWork.iss', import.meta.url), 'utf8');
const reload = fs.readFileSync(new URL('../generation-reload.js', import.meta.url), 'utf8');

test('runtime code generation always matches the coordinated manifest version', () => {
  const escaped = String(manifest.version).split('.').join('\\.');
  assert.match(background, new RegExp(`RUNTIME_CODE_VERSION = '${escaped}'`));
  assert.match(background, /manifestVersion !== RUNTIME_CODE_VERSION/);
  assert.match(background, /chrome\.runtime\.reload\(\)/);
  assert.match(reload, /chrome\.runtime\.reload\(\)/);
  assert.match(repair, /generation-reload\.html\?expected=/);
});

test('strict response confirmation only accepts exact terminal verifier proof', () => {
  assert.match(background, /expectedVerificationRequestId = requestId \? `cdp-\$\{tabId\}-\$\{requestId\}`/);
  assert.match(background, /state\.lastVerification\?\.verdict === 'verified'/);
  assert.match(background, /state\.lastVerification\?\.requestId === expectedVerificationRequestId/);
  assert.match(background, /verification_request_generation_or_authority_mismatch/);
});

test('Windows package ships the current causal jank collector', () => {
  assert.match(installer, /GPTWork-Jank-Diagnostic\.ps1/);
  assert.match(installer, /GPTWork 浏览器卡顿诊断/);
});
