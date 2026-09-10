import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createSiteReleaseFeed } from '../site-releases.mjs';

const SERVER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'github_pat_release_progress_test_secret';
const ORIGIN = 'https://gptlock.mv3.cn';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function asset(name, id, bytes) {
  return {
    name,
    url: `https://api.github.com/repos/b8vipvip/GPTWork/releases/assets/${id}`,
    browser_download_url: `https://github.com/b8vipvip/GPTWork/releases/download/v0.5.48/${name}`,
    size: bytes.length,
    digest: `sha256:${sha256(bytes)}`,
  };
}

test('GitHub 401 is classified as an invalid release token instead of a generic feed failure', async (t) => {
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'gptwork-release-auth-'));
  t.after(() => rmSync(mirrorRoot, { recursive: true, force: true }));

  const feed = createSiteReleaseFeed({
    serverRoot: SERVER_ROOT,
    env: {
      GPTLOCK_GITHUB_TOKEN: TOKEN,
      GPTLOCK_LICENSE_PUBLIC_ORIGIN: ORIGIN,
      GPTLOCK_RELEASE_MIRROR_DIR: mirrorRoot,
      GPTLOCK_RELEASE_FETCH_RETRIES: '1',
    },
    fetchImpl: async () => new Response(JSON.stringify({ message: 'Bad credentials' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const result = await feed.sync();
  assert.equal(result.latestVersion, null);
  assert.equal(result.warning, 'release_token_invalid');
  assert.equal(result.sync.stage, 'failed');
  assert.equal(result.sync.inProgress, false);
});

test('latest release assets start concurrently and live status exposes download progress', async (t) => {
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'gptwork-release-progress-'));
  t.after(() => rmSync(mirrorRoot, { recursive: true, force: true }));

  const first = Buffer.from('first-release-asset');
  const second = Buffer.from('second-release-asset');
  const assets = [
    asset('GPTWorkSetup-x64.exe', 1001, first),
    asset('gptwork-extension-0.5.48.zip', 1002, second),
  ];
  const bytesByUrl = new Map([
    [assets[0].url, first],
    [assets[1].url, second],
  ]);

  let releaseGateResolve;
  const releaseGate = new Promise((resolve) => { releaseGateResolve = resolve; });
  let assetCalls = 0;

  const feed = createSiteReleaseFeed({
    serverRoot: SERVER_ROOT,
    env: {
      GPTLOCK_GITHUB_TOKEN: TOKEN,
      GPTLOCK_LICENSE_PUBLIC_ORIGIN: ORIGIN,
      GPTLOCK_RELEASE_MIRROR_DIR: mirrorRoot,
      GPTLOCK_RELEASE_FETCH_RETRIES: '1',
      GPTLOCK_RELEASE_ASSET_TIMEOUT_MS: '30000',
    },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes('/releases?per_page=12')) {
        return new Response(JSON.stringify([{
          tag_name: 'v0.5.48',
          name: 'GPTWork v0.5.48',
          draft: false,
          prerelease: false,
          published_at: '2026-09-09T00:00:00Z',
          assets,
        }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (bytesByUrl.has(target)) {
        assetCalls += 1;
        await releaseGate;
        return new Response(bytesByUrl.get(target), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${target}`);
    },
  });

  const pending = feed.sync();
  for (let index = 0; index < 50 && assetCalls < 2; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  assert.equal(assetCalls, 2, 'both latest-release assets should be in flight before either completes');
  const during = await feed.load();
  assert.equal(during.sync.stage, 'downloading_latest');
  assert.equal(during.sync.inProgress, true);
  assert.equal(during.sync.completedAssets, 0);
  assert.equal(during.sync.totalAssets, 2);
  assert.equal(during.sync.activeAssets.length, 2);

  releaseGateResolve();
  const result = await pending;
  assert.equal(result.latestVersion, '0.5.48');
  assert.equal(result.sync.stage, 'completed');
  assert.equal(result.sync.completedAssets, 2);
  assert.equal(result.sync.totalAssets, 2);
});
