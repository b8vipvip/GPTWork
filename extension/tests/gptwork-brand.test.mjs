import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

test('GPTWork is canonical product metadata', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.equal(manifest.name, 'GPTWork');
  const readmeVersion = read('README.md').match(/当前正式版本：\*\*([^*]+)\*\*/)?.[1];
  assert.equal(readmeVersion, manifest.version, 'README must advertise the actual packaged release version');
  assert.equal(manifest.action.default_title, 'GPTWork');
  assert.equal(JSON.parse(read('extension/package.json')).name, 'gptwork-extension');
  assert.match(read('native-core/Cargo.toml'), /name = "gptwork-core"/);
  assert.match(read('private-engine/Cargo.toml'), /name = "gptwork-private-engine"/);
  assert.match(read('packaging/windows/GPTWork.iss'), /OutputBaseFilename=GPTWorkSetup-x64/);
});

test('user-facing HTML/CSS no longer exposes legacy product brand', () => {
  for (const rootName of ['extension', 'license-server/public']) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(?:html|css)$/.test(entry.name)) {
          const source = fs.readFileSync(file, 'utf8').replaceAll('https://github.com/b8vipvip/GPTLock', 'https://github.com/b8vipvip/REPOSITORY');
          assert.doesNotMatch(source, /GPTLock|(?<![A-Za-z0-9_])GPTLOCK(?![A-Za-z0-9_-])/, path.relative(repo, file));
        }
      }
    };
    walk(path.join(repo, rootName));
  }
});

test('future release artifacts use exact GPTWork names while protocol compatibility identifiers remain stable', () => {
  const release = read('.github/workflows/release.yml');
  const linuxBuilder = read('packaging/linux/build-deb.sh');
  const linuxUpdater = read('packaging/linux/update.sh');
  assert.match(release, /GPTWork-core-\$\{RELEASE_VERSION\}-linux-x64\.tar\.gz/);
  assert.match(release, /GPTWork-extension-\$\{RELEASE_VERSION\}\.zip/);
  assert.match(release, /GPTWorkSetup-x64\.exe/);
  assert.match(linuxBuilder, /GPTWork_\$\{version\}_\$\{architecture\}\.deb/);
  assert.match(linuxUpdater, /preferred = f"GPTWork_\{version\}_amd64\.deb"/);
  assert.doesNotMatch(release, /GPTLockSetup-x64\.exe|gptlock-core-\$\{RELEASE_VERSION\}|gptlock-extension-\$\{RELEASE_VERSION\}|gptlock_\$\{RELEASE_VERSION\}_amd64\.deb/);
  assert.doesNotMatch(read('extension/update-manager.js'), /LEGACY_WINDOWS_INSTALLER_NAME|GPTLockSetup-x64\.exe/);
  assert.doesNotMatch(linuxUpdater, /gptlock_\{version\}_amd64\.deb/);
  assert.match(read('extension/manifest.json'), /https:\/\/gptlock\.mv3\.cn\/\*/);
  assert.match(read('native-core/src/lib.rs'), /com\.gptlock\.core/);
});
