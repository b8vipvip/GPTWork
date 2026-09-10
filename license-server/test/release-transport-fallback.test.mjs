import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { normalizeReleaseProxy } from '../release-http.mjs';
import { createSiteReleaseFeed } from '../site-releases.mjs';

const SERVER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'github_pat_release_transport_test';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('release proxy accepts only explicit HTTP/SOCKS proxy schemes', () => {
  assert.equal(normalizeReleaseProxy('socks5h://127.0.0.1:10808'), 'socks5h://127.0.0.1:10808');
  assert.equal(normalizeReleaseProxy('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(normalizeReleaseProxy('vless://example.com:443'), null);
  assert.equal(normalizeReleaseProxy('file:///tmp/socket'), null);
  assert.equal(normalizeReleaseProxy(''), null);
});

test('release mirror falls back from failed Node fetch to injected curl transport without exposing token', async (t) => {
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'gptwork-release-curl-fallback-'));
  t.after(() => rmSync(mirrorRoot, { recursive: true, force: true }));

  const installer = Buffer.from('curl-fallback-installer');
  const digest = `sha256:${sha256(installer)}`;
  const assetUrl = 'https://api.github.com/repos/b8vipvip/GPTWork/releases/assets/9001';
  const releases = [{
    tag_name: 'v0.5.48',
    name: 'GPTWork v0.5.48',
    draft: false,
    prerelease: false,
    published_at: '2026-09-09T00:00:00Z',
    assets: [{
      name: 'GPTWorkSetup-x64.exe',
      url: assetUrl,
      size: installer.length,
      digest,
    }],
  }];

  let directCalls = 0;
  const curlCalls = [];
  const curlTransport = {
    proxyConfigured: false,
    proxyInvalid: false,
    async request(url, options = {}) {
      curlCalls.push({ url: String(url), options });
      if (String(url).includes('/releases?per_page=12')) {
        return new Response(JSON.stringify(releases), { status: 200 });
      }
      if (String(url) === assetUrl) return new Response(installer, { status: 200 });
      throw new Error(`unexpected curl URL ${url}`);
    },
  };

  const feed = createSiteReleaseFeed({
    serverRoot: SERVER_ROOT,
    env: {
      GPTLOCK_GITHUB_TOKEN: TOKEN,
      GPTLOCK_LICENSE_PUBLIC_ORIGIN: 'https://gptlock.mv3.cn',
      GPTLOCK_RELEASE_MIRROR_DIR: mirrorRoot,
      GPTLOCK_RELEASE_FETCH_RETRIES: '1',
      GPTLOCK_RELEASE_TRANSPORT: 'auto',
    },
    fetchImpl: async () => {
      directCalls += 1;
      throw new TypeError('fetch failed');
    },
    curlTransport,
  });

  const result = await feed.sync();
  assert.equal(directCalls, 2);
  assert.equal(curlCalls.length, 2);
  assert.equal(result.latestVersion, '0.5.48');
  assert.equal(result.source, 'server-mirror');
  assert.equal(result.mirror.lastTransport, 'curl-direct');
  assert.equal(result.mirror.lastError, null);
  assert.equal(curlCalls.every((call) => call.options.headers.Authorization === `Bearer ${TOKEN}`), true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});
