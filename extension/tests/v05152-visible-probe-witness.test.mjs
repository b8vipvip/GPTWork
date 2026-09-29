import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cargoToml = await readFile(new URL('../../native-core/Cargo.toml', import.meta.url), 'utf8');
const cargoLock = await readFile(new URL('../../native-core/Cargo.lock', import.meta.url), 'utf8');
const installer = await readFile(new URL('../../packaging/windows/GPTWork.iss', import.meta.url), 'utf8');

test('auto verification checks the actual visible prompt text rather than a semantic marker', () => {
  const start = content.indexOf('async function autoSendProbe(options = {})');
  const end = content.indexOf('async function resolveModelNamesWithChatGpt', start);
  assert.ok(start >= 0 && end > start);
  const block = content.slice(start, end);

  assert.match(block, /const probeMarker = typeof options\.probeMarker/);
  assert.match(block, /const composerWitness = probeText\.slice\(0, 120\)/);
  assert.match(block, /composerText\(composer\)\.includes\(composerWitness\)/);
  assert.match(block, /!current\.includes\(composerWitness\)/);
  assert.doesNotMatch(block, /composerText\(composer\)\.includes\(probeMarker\)/);
  assert.doesNotMatch(block, /!current\.includes\(probeMarker\)/);
});

test('background may keep semantic verification markers separate from randomized prompt text', () => {
  const start = background.indexOf('async function sendVerificationReasoningProbe');
  assert.ok(start >= 0);
  const block = background.slice(start, start + 700);
  assert.match(block, /const prompt = await randomVerificationPrompt\(\)/);
  assert.match(block, /probeMarker: marker/);
  assert.match(block, /probeText: prompt/);
});

test('v0.5.152 release version surfaces stay synchronized', () => {
  assert.equal(manifest.version, '0.5.152');
  assert.equal(pkg.version, '0.5.152');
  assert.match(background, /const RUNTIME_CODE_VERSION = '0\.5\.152'/);
  assert.match(cargoToml, /version = "0\.5\.152"/);
  assert.match(cargoLock, /name = "gptwork-core"\nversion = "0\.5\.152"/);
  assert.match(installer, /#define MyAppVersion "0\.5\.152"/);
});
