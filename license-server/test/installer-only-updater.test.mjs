import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WINDOWS_UPDATER = readFileSync(join(REPOSITORY_ROOT, 'packaging', 'windows', 'Update-GPTWork.ps1'), 'utf8');
const LINUX_UPDATER = readFileSync(join(REPOSITORY_ROOT, 'packaging', 'linux', 'update.sh'), 'utf8');
const WINDOWS_INSTALLER = readFileSync(join(REPOSITORY_ROOT, 'packaging', 'windows', 'GPTWork.iss'), 'utf8');
const EXTENSION_VERSION = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'extension', 'manifest.json'), 'utf8')).version;
const VERSION_PATTERN = EXTENSION_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('manual updaters work with installer-only releases and verify published digests', () => {
  assert.match(WINDOWS_UPDATER, /\$repository = 'b8vipvip\/GPTWork'/);
  assert.match(WINDOWS_UPDATER, /installerAsset\.digest/);
  assert.match(WINDOWS_UPDATER, /Get-FileHash[^\n]+SHA256/);
  assert.doesNotMatch(WINDOWS_UPDATER, /SHA256SUMS\.txt/);

  assert.match(LINUX_UPDATER, /digest\(assets\[name\]\)/);
  assert.match(LINUX_UPDATER, /sha256sum/);
  assert.doesNotMatch(LINUX_UPDATER, /SHA256SUMS\.txt/);
});

test('Windows installer metadata points at the current GPTWork repository and matches the extension version', () => {
  assert.match(WINDOWS_INSTALLER, new RegExp(`#define MyAppVersion "${VERSION_PATTERN}"`));
  assert.match(WINDOWS_INSTALLER, /#define MyAppURL "https:\/\/github\.com\/b8vipvip\/GPTWork"/);
  assert.doesNotMatch(WINDOWS_INSTALLER, /github\.com\/b8vipvip\/GPTLock/);
});
