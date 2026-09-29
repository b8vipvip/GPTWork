import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const promptText = await readFile(new URL('../prompt-bank.json', import.meta.url), 'utf8');
const promptBank = JSON.parse(promptText);

function gitBlobSha(text) {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(Buffer.from(`blob ${body.length}\0`, 'utf8'))
    .update(body)
    .digest('hex');
}

test('bundles the exact ModelPro v0.1.45 verification prompt bank required by live probes', () => {
  assert.equal(promptBank.version, 1);
  assert.ok(Array.isArray(promptBank.prompts));
  assert.ok(promptBank.prompts.length >= 100);
  assert.ok(promptBank.prompts.every((item) => typeof item === 'string' && item.trim().length > 0));
  assert.equal(gitBlobSha(promptText), '33dc4075e47c70ade8164e6c5a87230cd3bad0c8');
});

test('background loads and validates the packaged prompt bank before every uncached live verification run', () => {
  assert.match(background, /fetch\(chrome\.runtime\.getURL\('prompt-bank\.json'\)\)/);
  assert.match(background, /Prompt bank load failed/);
  assert.match(background, /Prompt bank must contain at least 100 prompts/);
  assert.match(background, /async function randomVerificationPrompt\(\)/);
});
