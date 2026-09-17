import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = resolve(SCRIPT_DIR, '.capability-lease-key');

function usage() {
  return [
    'Usage: node generate-capability-lease-key.mjs [--out <directory>]',
    '',
    'Generates one Ed25519 deployment key pair without printing the private key.',
    'The output directory must not already exist.',
  ].join('\n');
}

function outputDirectory(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (argv.length === 0) return DEFAULT_OUTPUT_DIR;
  if (argv.length !== 2 || argv[0] !== '--out' || !String(argv[1] || '').trim()) {
    throw new Error(usage());
  }
  return resolve(process.cwd(), argv[1]);
}

function generateDeploymentKey(outputDir) {
  mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicJwk = publicKey.export({ format: 'jwk' });
  if (publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' || !publicJwk.x) {
    throw new Error('Generated capability lease public key is not Ed25519');
  }

  const privatePath = resolve(outputDir, 'private-key.pem');
  const publicPemPath = resolve(outputDir, 'public-key.pem');
  const publicRawPath = resolve(outputDir, 'public-key.base64url');
  writeFileSync(privatePath, privatePem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  writeFileSync(publicPemPath, publicPem, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  writeFileSync(publicRawPath, `${publicJwk.x}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' });

  return { privatePath, publicPemPath, publicRawPath, publicRawBase64Url: publicJwk.x };
}

try {
  const outputDir = outputDirectory(process.argv.slice(2));
  const generated = generateDeploymentKey(outputDir);
  process.stdout.write([
    'Capability lease Ed25519 deployment key pair generated.',
    `Private key file: ${generated.privatePath}`,
    `Public key PEM: ${generated.publicPemPath}`,
    `Public key base64url file: ${generated.publicRawPath}`,
    `GPTWORK_CAPABILITY_LEASE_PUBLIC_KEY_B64=${generated.publicRawBase64Url}`,
    '',
    'Keep private-key.pem only in the account-service deployment secret store.',
    'The public base64url value is the value pinned into production private-engine builds.',
  ].join('\n') + '\n');
} catch (error) {
  process.stderr.write(`Capability lease key generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
