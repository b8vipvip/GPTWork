import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createSiteReleaseFeed } from '../site-releases.mjs';

const SERVER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'github_pat_private_release_read_only_test_secret';
const ORIGIN = 'https://gptlock.mv3.cn';
const INSTALLER = 'GPTWorkSetup-x64.exe';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function releaseRow({ tag = 'v0.5.48', assets }) {
  return [{
    tag_name: tag,
    name: `GPTWork ${tag}`,
    body: `Release notes for ${tag}`,
    draft: false,
    prerelease: false,
    published_at: '2026-09-09T00:00:00Z',
    assets,
  }];
}

function asset(name, id, bytes, tag = 'v0.5.48') {
  return {
    name,
    url: `https://api.github.com/repos/b8vipvip/GPTWork/releases/assets/${id}`,
    browser_download_url: `https://github.com/b8vipvip/GPTWork/releases/download/${tag}/${name}`,
    size: bytes.length,
    digest: `sha256:${sha256(bytes)}`,
  };
}

function testFeed({ mirrorRoot, currentRelease }) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/releases?per_page=12')) {
      return new Response(JSON.stringify(currentRelease()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const rows = currentRelease();
    const found = rows.flatMap((row) => row?.assets || []).find((item) => item.url === String(url));
    if (!found) throw new Error(`Unexpected URL: ${url}`);
    const bytes = rows.bytesByUrl?.[found.url] ?? rows.bytesByName?.[found.name];
    if (!bytes) throw new Error(`Missing fixture bytes: ${found.name}`);
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  };
  const feed = createSiteReleaseFeed({
    serverRoot: SERVER_ROOT,
    fetchImpl,
    env: {
      GPTLOCK_GITHUB_TOKEN: TOKEN,
      GPTLOCK_LICENSE_PUBLIC_ORIGIN: ORIGIN,
      GPTLOCK_RELEASE_MIRROR_DIR: mirrorRoot,
      GPTLOCK_RELEASE_SYNC_INTERVAL_MS: '60000',
      GPTLOCK_RELEASE_FETCH_RETRIES: '1',
    },
  });
  return { feed, calls };
}

function fixture(tag = 'v0.5.48', idBase = 100) {
  const installer = Buffer.from(`installer-${tag}`);
  const extension = Buffer.from(`extension-${tag}`);
  const sums = Buffer.from(`${sha256(installer)}  ${INSTALLER}\n${sha256(extension)}  gptwork-extension-${tag.slice(1)}.zip\n`);
  const rows = releaseRow({
    tag,
    assets: [
      asset(INSTALLER, idBase + 1, installer, tag),
      asset(`gptwork-extension-${tag.slice(1)}.zip`, idBase + 2, extension, tag),
      asset('SHA256SUMS.txt', idBase + 3, sums, tag),
    ],
  });
  rows.bytesByName = {
    [INSTALLER]: installer,
    [`gptwork-extension-${tag.slice(1)}.zip`]: extension,
    'SHA256SUMS.txt': sums,
  };
  rows.bytesByUrl = Object.fromEntries(rows[0].assets.map((item) => [item.url, rows.bytesByName[item.name]]));
  return rows;
}

function combineFixtures(...fixtures) {
  const rows = fixtures.flatMap((item) => item);
  rows.bytesByUrl = Object.assign({}, ...fixtures.map((item) => item.bytesByUrl || {}));
  rows.bytesByName = Object.assign({}, ...fixtures.map((item) => item.bytesByName || {}));
  return rows;
}

test('private GitHub releases are fully mirrored to the official server with verified digests', async (t) => {
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'gptwork-release-mirror-'));
  t.after(() => rmSync(mirrorRoot, { recursive: true, force: true }));
  let rows = fixture();
  const { feed, calls } = testFeed({ mirrorRoot, currentRelease: () => rows });

  const result = await feed.sync();
  assert.equal(result.ok, true);
  assert.equal(result.source, 'server-mirror');
  assert.equal(result.latestVersion, '0.5.48');
  assert.equal(result.releases.length, 1);
  assert.equal(result.releases[0].assets.length, 3);
  assert.match(result.generation, /^[0-9a-f]{24}$/);

  for (const mirrored of result.releases[0].assets) {
    assert.equal(
      mirrored.url,
      `${ORIGIN}/downloads/releases/v0.5.48/${encodeURIComponent(mirrored.name)}`,
    );
    const path = join(mirrorRoot, 'v0.5.48', mirrored.name);
    assert.equal(existsSync(path), true);
    assert.equal(`sha256:${sha256(readFileSync(path))}`, mirrored.digest);
  }
  assert.equal(existsSync(join(mirrorRoot, 'index.json')), true);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls.slice(1).every((call) => call.options.headers.Authorization === `Bearer ${TOKEN}`), true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(result), /release-assets\.githubusercontent\.com/);
});

test('a second sync reuses already verified local assets instead of downloading them again', async (t) => {
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'gptwork-release-reuse-'));
  t.after(() => rmSync(mirrorRoot, { recursive: true, force: true }));
  const rows = fixture();
  const { feed, calls } = testFeed({ mirrorRoot, currentRelease: () => rows });

  await feed.sync();
  const firstAssetCalls = calls.filter((call) => call.url.includes('/releases/assets/')).length;
  await feed.sync();
  const secondAssetCalls = calls.filter((call) => call.url.includes('/releases/assets/')).length;

  assert.equal(firstAssetCalls, 3);
  assert.equal(secondAssetCalls, 3);
});

test('latest release publication is atomic when one of its assets fails verification', async (t) => {
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'gptwork-release-atomic-'));
  t.after(() => rmSync(mirrorRoot, { recursive: true, force: true }));
  const rows = fixture();
  rows[0].assets[1].digest = `sha256:${'0'.repeat(64)}`;
  const { feed } = testFeed({ mirrorRoot, currentRelease: () => rows });

  const result = await feed.sync();
  assert.equal(result.source, 'local');
  assert.equal(result.warning, 'release_feed_unavailable');
  assert.deepEqual(result.releases, []);
  assert.equal(existsSync(join(mirrorRoot, 'index.json')), false);
});

test('a broken historical release never blocks a fully verified newest release', async (t) => {
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'gptwork-release-latest-first-'));
  t.after(() => rmSync(mirrorRoot, { recursive: true, force: true }));
  const latest = fixture('v0.5.49', 200);
  const historical = fixture('v0.5.48', 300);
  historical[0].assets[1].digest = `sha256:${'0'.repeat(64)}`;
  const rows = combineFixtures(latest, historical);
  const { feed } = testFeed({ mirrorRoot, currentRelease: () => rows });

  const result = await feed.sync();
  assert.equal(result.source, 'server-mirror');
  assert.equal(result.latestVersion, '0.5.49');
  assert.equal(result.releases[0].tag, 'v0.5.49');
  assert.equal(result.releases[0].assets.length, 3);
  assert.equal(result.warning, 'release_history_partial');
  assert.equal(existsSync(join(mirrorRoot, 'index.json')), true);
  assert.equal(existsSync(join(mirrorRoot, 'v0.5.49', INSTALLER)), true);
});

test('notification wait resolves when a newly mirrored release changes the generation', async (t) => {
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'gptwork-release-notify-'));
  t.after(() => rmSync(mirrorRoot, { recursive: true, force: true }));
  let rows = fixture('v0.5.48', 400);
  const { feed } = testFeed({ mirrorRoot, currentRelease: () => rows });
  const first = await feed.sync();

  const pending = feed.waitForChange(first.generation, 2_000);
  rows = fixture('v0.5.49', 500);
  await feed.sync();
  const notification = await pending;
  const payload = feed.notificationPayload(notification);

  assert.equal(payload.changed, true);
  assert.equal(payload.latestVersion, '0.5.49');
  assert.notEqual(payload.generation, first.generation);
});

test('private repository without a server token never contacts GitHub and safely serves the local mirror state', async (t) => {
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'gptwork-release-no-token-'));
  t.after(() => rmSync(mirrorRoot, { recursive: true, force: true }));
  let calls = 0;
  const feed = createSiteReleaseFeed({
    serverRoot: SERVER_ROOT,
    env: {
      GPTLOCK_LICENSE_PUBLIC_ORIGIN: ORIGIN,
      GPTLOCK_RELEASE_MIRROR_DIR: mirrorRoot,
    },
    fetchImpl: async () => {
      calls += 1;
      throw new Error('must not be called');
    },
  });

  const result = await feed.sync();
  assert.equal(calls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'local');
  assert.equal(result.warning, 'private_release_token_required');
  assert.deepEqual(result.releases, []);

  const loaded = await feed.load();
  assert.equal(loaded.warning, 'private_release_token_required');
});
