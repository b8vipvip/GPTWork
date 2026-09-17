import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../generate-capability-lease-key.mjs', import.meta.url));

test('deployment key generator writes a matching Ed25519 pair without printing the private key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gptwork-capability-keygen-'));
  const outputDir = join(root, 'keypair');
  try {
    const result = spawnSync(process.execPath, [script, '--out', outputDir], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /BEGIN PRIVATE KEY/);

    const privatePem = await readFile(join(outputDir, 'private-key.pem'), 'utf8');
    const publicRaw = (await readFile(join(outputDir, 'public-key.base64url'), 'utf8')).trim();
    assert.match(privatePem, /BEGIN PRIVATE KEY/);
    assert.match(publicRaw, /^[A-Za-z0-9_-]{43}$/);

    const privateKey = createPrivateKey(privatePem);
    assert.equal(privateKey.asymmetricKeyType, 'ed25519');
    const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' });
    assert.equal(publicJwk.kty, 'OKP');
    assert.equal(publicJwk.crv, 'Ed25519');
    assert.equal(publicJwk.x, publicRaw);
    assert.match(result.stdout, new RegExp(`GPTWORK_CAPABILITY_LEASE_PUBLIC_KEY_B64=${publicRaw}`));

    const duplicate = spawnSync(process.execPath, [script, '--out', outputDir], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /key generation failed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
