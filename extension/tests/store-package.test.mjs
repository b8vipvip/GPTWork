import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('../../packaging/store/build-store-package.mjs', import.meta.url);

function build(browser, extensionId) {
  const root = mkdtempSync(join(tmpdir(), `gptwork-${browser}-store-`));
  const result = spawnSync(process.execPath, [
    script.pathname,
    '--browser', browser,
    '--out', root,
    '--extension-id', extensionId,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return root;
}

for (const fixture of [
  { browser: 'chrome', id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', channel: 'chrome-store', host: 'chromewebstore.google.com' },
  { browser: 'edge', id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', channel: 'edge-store', host: 'microsoftedge.microsoft.com' },
]) {
  test(`${fixture.browser} store package is store-managed and excludes standalone updater`, () => {
    const root = build(fixture.browser, fixture.id);
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
      assert.equal(manifest.key, undefined);
      assert.equal(manifest.background.service_worker, 'background-entry-store.js');
      assert.equal(manifest.permissions.includes('downloads'), false);
      assert.equal(existsSync(join(root, 'background-update.js')), false);
      assert.equal(existsSync(join(root, 'options-update.js')), false);
      assert.equal(existsSync(join(root, 'background-entry-store.js')), true);
      assert.equal(existsSync(join(root, 'store-update-page.js')), true);

      const settings = readFileSync(join(root, 'settings-v0521.html'), 'utf8');
      assert.match(settings, /store-update-page\.js/);
      assert.doesNotMatch(settings, /options-update\.js/);

      const channel = readFileSync(join(root, 'distribution-channel.js'), 'utf8');
      assert.match(channel, new RegExp(`DISTRIBUTION_CHANNEL = ["']${fixture.channel}["']`));
      assert.match(channel, new RegExp(`STORE_EXTENSION_ID = ["']${fixture.id}["']`));
      assert.match(channel, new RegExp(fixture.host.replaceAll('.', '\\.')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('store package can be built before official store ids exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'gptwork-store-no-id-'));
  const result = spawnSync(process.execPath, [script.pathname, '--browser', 'chrome', '--out', root], { encoding: 'utf8' });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const channel = readFileSync(join(root, 'distribution-channel.js'), 'utf8');
    assert.match(channel, /STORE_EXTENSION_ID = ["']{2}/);
    assert.match(channel, /STORE_LISTING_URL = ["']{2}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
