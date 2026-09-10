import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { createCurlReleaseTransport } from './release-http.mjs';

const RELEASES_API = 'https://api.github.com/repos/b8vipvip/GPTWork/releases?per_page=12';
const DEFAULT_ORIGIN = 'https://gptlock.mv3.cn';
const DEFAULT_SYNC_MS = 60 * 1000;
const DEFAULT_FETCH_RETRIES = 2;
const DEFAULT_ASSET_TIMEOUT_MS = 60 * 1000;
const MAX_NOTIFICATION_WAIT_MS = 25 * 1000;
const MIN_PUBLIC_RELEASE_TAG = 'v0.5.48';
const SAFE_TAG = /^v\d+(?:\.\d+){1,3}$/i;
const SAFE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._+()-]{0,159}$/;
const CONTENT_TYPES = new Map([
  ['.exe', 'application/octet-stream'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.deb', 'application/vnd.debian.binary-package'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function currentVersion(serverRoot) {
  try {
    const manifest = JSON.parse(readFileSync(join(serverRoot, '..', 'extension', 'manifest.json'), 'utf8'));
    return String(manifest.version || 'unknown');
  } catch {
    return 'unknown';
  }
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || DEFAULT_ORIGIN));
    return url.protocol === 'https:' ? url.origin : DEFAULT_ORIGIN;
  } catch {
    return DEFAULT_ORIGIN;
  }
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicJson(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function digestValue(value) {
  const match = String(value || '').trim().match(/^sha256:([0-9a-f]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

function contentType(name) {
  const lower = String(name || '').toLowerCase();
  for (const [suffix, type] of CONTENT_TYPES) {
    if (lower.endsWith(suffix)) return type;
  }
  return 'application/octet-stream';
}

function generationFor(releases) {
  const fingerprint = releases.map((release) => ({
    tag: release.tag,
    publishedAt: release.publishedAt,
    assets: release.assets.map((asset) => [asset.name, asset.digest, asset.size]),
  }));
  return createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 24);
}

function safeReleaseRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => !row?.draft && !row?.prerelease && SAFE_TAG.test(String(row?.tag_name || '')) && isPublicReleaseTag(row?.tag_name))
    .slice(0, 12);
}

function defaultMirrorRoot(serverRoot, env) {
  const dbPath = String(env.GPTLOCK_LICENSE_DB || '').trim();
  if (dbPath) return join(dirname(resolve(dbPath)), 'releases');
  return join(serverRoot, 'data', 'releases');
}

function errorText(error) {
  return (error instanceof Error ? error.message : String(error || 'unknown error')).slice(0, 1000);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function transportPolicy(value) {
  const normalized = String(value || 'auto').trim().toLowerCase();
  return ['auto', 'fetch', 'curl'].includes(normalized) ? normalized : 'auto';
}

function boundedNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function releaseVersionParts(tag) {
  const match = String(tag || '').trim().match(/^v(\d+(?:\.\d+){1,3})$/i);
  if (!match) return null;
  const parts = match[1].split('.').map((part) => Number(part));
  while (parts.length < 4) parts.push(0);
  return parts;
}

function compareReleaseTags(left, right) {
  const a = releaseVersionParts(left);
  const b = releaseVersionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function isPublicReleaseTag(tag) {
  const compared = compareReleaseTags(tag, MIN_PUBLIC_RELEASE_TAG);
  return compared !== null && compared >= 0;
}

export function createSiteReleaseFeed({
  serverRoot,
  fetchImpl = fetch,
  env = process.env,
  curlTransport: injectedCurlTransport = null,
}) {
  const token = String(env.GPTLOCK_GITHUB_TOKEN || env.GH_TOKEN || '').trim();
  const publicOrigin = normalizeOrigin(env.GPTLOCK_LICENSE_PUBLIC_ORIGIN);
  const mirrorRoot = resolve(env.GPTLOCK_RELEASE_MIRROR_DIR || defaultMirrorRoot(serverRoot, env));
  const indexPath = join(mirrorRoot, 'index.json');
  const syncIntervalMs = Math.max(30_000, Number(env.GPTLOCK_RELEASE_SYNC_INTERVAL_MS || DEFAULT_SYNC_MS));
  const fetchRetries = Math.max(1, Math.min(5, Number(env.GPTLOCK_RELEASE_FETCH_RETRIES || DEFAULT_FETCH_RETRIES)));
  const assetTimeoutMs = boundedNumber(env.GPTLOCK_RELEASE_ASSET_TIMEOUT_MS, 10_000, 180_000, DEFAULT_ASSET_TIMEOUT_MS);
  const policy = transportPolicy(env.GPTLOCK_RELEASE_TRANSPORT);
  const currentProductVersion = currentVersion(serverRoot);
  const productionFetch = fetchImpl === globalThis.fetch;
  const curlTransport = injectedCurlTransport || (productionFetch ? createCurlReleaseTransport({ env }) : null);
  const waiters = new Set();

  let timer = null;
  let syncing = null;
  let cache = null;
  let storageError = null;
  let lastWarning = null;
  let lastSyncAttemptAt = null;
  let lastSyncSuccessAt = null;
  let lastSyncErrorAt = null;
  let lastSyncError = null;
  let lastTransport = null;
  let historyFailures = [];
  let lastLoggedError = null;
  let lastLoggedPublishedVersion = null;
  let privacyCleanupError = null;
  let progress = {
    stage: 'idle',
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    releaseTag: null,
    currentAsset: null,
    activeAssets: [],
    completedAssets: 0,
    totalAssets: 0,
    historyIndex: 0,
    historyTotal: 0,
  };

  function prunePrivateHistoricalMirrors() {
    privacyCleanupError = null;
    try {
      for (const entry of readdirSync(mirrorRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !SAFE_TAG.test(entry.name) || isPublicReleaseTag(entry.name)) continue;
        rmSync(join(mirrorRoot, entry.name), { recursive: true, force: true });
        console.warn(`[release-mirror] removed non-public historical mirror ${entry.name}`);
      }
    } catch (error) {
      privacyCleanupError = error instanceof Error ? error : new Error(String(error));
      console.warn(`[release-mirror] historical privacy cleanup failed: ${errorText(privacyCleanupError)}`);
    }
  }

  function ensureStorage() {
    try {
      mkdirSync(mirrorRoot, { recursive: true, mode: 0o700 });
      prunePrivateHistoricalMirrors();
      storageError = null;
      return true;
    } catch (error) {
      storageError = error instanceof Error ? error : new Error(String(error));
      return false;
    }
  }

  ensureStorage();

  function updateProgress(stage, patch = {}) {
    progress = {
      ...progress,
      ...patch,
      stage,
      updatedAt: new Date().toISOString(),
    };
  }

  function resetProgress(stage = 'idle') {
    const now = new Date().toISOString();
    progress = {
      stage,
      startedAt: stage === 'idle' ? null : now,
      updatedAt: now,
      finishedAt: null,
      releaseTag: null,
      currentAsset: null,
      activeAssets: [],
      completedAssets: 0,
      totalAssets: 0,
      historyIndex: 0,
      historyTotal: 0,
    };
  }

  function publicProgress() {
    const started = progress.startedAt ? Date.parse(progress.startedAt) : NaN;
    return {
      ...progress,
      inProgress: Boolean(syncing) || !['idle', 'completed', 'failed'].includes(progress.stage),
      transport: lastTransport,
      elapsedMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0,
    };
  }

  function githubHeaders(accept = 'application/vnd.github+json') {
    const headers = {
      Accept: accept,
      'User-Agent': 'GPTWork-release-mirror/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function fetchDirect(url, options, timeoutMs) {
    let lastError = null;
    let lastResponse = null;
    for (let attempt = 1; attempt <= fetchRetries; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          ...options,
          signal: AbortSignal.timeout(timeoutMs),
        });
        lastResponse = response;
        lastTransport = 'node-fetch';
        if (response.ok || (response.status < 500 && response.status !== 429)) return response;
        lastError = new Error(`GitHub request returned ${response.status}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < fetchRetries) await sleep(250 * attempt);
    }
    if (lastResponse) return lastResponse;
    throw lastError || new Error('GitHub request failed');
  }

  async function fetchCurl(url, options, timeoutMs) {
    if (!curlTransport) throw new Error('Release cURL transport is unavailable');
    let lastError = null;
    for (let attempt = 1; attempt <= fetchRetries; attempt += 1) {
      try {
        const response = await curlTransport.request(url, {
          headers: options?.headers || {},
          timeoutMs,
        });
        lastTransport = curlTransport.proxyConfigured ? 'curl-proxy' : 'curl-direct';
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < fetchRetries) await sleep(250 * attempt);
    }
    throw lastError || new Error('Release cURL request failed');
  }

  async function githubFetch(url, options = {}, timeoutMs = 15_000) {
    if (curlTransport?.proxyInvalid) {
      throw new Error('GPTLOCK_RELEASE_PROXY is configured but invalid');
    }

    const proxyFirst = Boolean(curlTransport?.proxyConfigured);
    if (policy === 'curl' || proxyFirst) return fetchCurl(url, options, timeoutMs);
    if (policy === 'fetch' || !curlTransport) return fetchDirect(url, options, timeoutMs);

    try {
      const response = await fetchDirect(url, options, timeoutMs);
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
    } catch (fetchError) {
      try {
        return await fetchCurl(url, options, timeoutMs);
      } catch (curlError) {
        throw new Error(`Node fetch failed: ${errorText(fetchError)}; cURL fallback failed: ${errorText(curlError)}`);
      }
    }

    return fetchCurl(url, options, timeoutMs);
  }

  function normalizedIndex(raw = {}) {
    const rawReleases = Array.isArray(raw.releases) ? raw.releases : [];
    const releases = rawReleases.filter((release) => isPublicReleaseTag(release?.tag));
    const removedPrivateHistory = releases.length !== rawReleases.length;
    return {
      ok: true,
      currentVersion: currentProductVersion,
      minimumPublicVersion: MIN_PUBLIC_RELEASE_TAG.replace(/^v/i, ''),
      source: releases.length ? 'server-mirror' : 'local',
      generation: removedPrivateHistory ? generationFor(releases) : String(raw.generation || generationFor(releases)),
      mirroredAt: raw.mirroredAt || null,
      latestVersion: releases[0]?.tag?.replace(/^v/i, '') || null,
      releases,
    };
  }

  function loadIndex() {
    if (cache) return cache;
    const raw = readJson(indexPath, {});
    cache = normalizedIndex(raw);
    if (Array.isArray(raw.releases) && raw.releases.length !== cache.releases.length) atomicJson(indexPath, cache);
    return cache;
  }

  function publicView(feed = loadIndex()) {
    let warning = lastWarning;
    if (storageError) warning = 'release_mirror_storage_unavailable';
    const view = { ...feed, sync: publicProgress() };
    return warning ? { ...view, warning } : view;
  }

  function notifyWaiters(next) {
    for (const resolveWaiter of waiters) resolveWaiter(next);
    waiters.clear();
  }

  function publishIndex(releases) {
    const previous = loadIndex();
    const publishable = releases.filter((release) => isPublicReleaseTag(release?.tag));
    const generation = generationFor(publishable);
    const next = normalizedIndex({
      generation,
      mirroredAt: new Date().toISOString(),
      releases: publishable,
    });
    atomicJson(indexPath, next);
    cache = next;
    if (generation !== previous.generation) notifyWaiters(next);
    return next;
  }

  function releaseAssetsAvailable(release) {
    if (!release || !SAFE_TAG.test(String(release.tag || '')) || !isPublicReleaseTag(release.tag) || !Array.isArray(release.assets)) return false;
    return release.assets.every((asset) => {
      const name = String(asset?.name || '');
      if (!SAFE_ASSET.test(name) || basename(name) !== name) return false;
      const path = join(mirrorRoot, release.tag, name);
      if (!existsSync(path)) return false;
      const expectedSize = Math.max(0, Number(asset?.size || 0));
      if (expectedSize && statSync(path).size !== expectedSize) return false;
      const expectedDigest = digestValue(asset?.digest);
      return !expectedDigest || sha256File(path) === expectedDigest;
    });
  }

  async function downloadAsset(releaseTag, asset) {
    if (!isPublicReleaseTag(releaseTag)) throw new Error(`Release ${releaseTag} is below the public release floor`);
    const name = basename(String(asset?.name || ''));
    if (!SAFE_ASSET.test(name) || name !== String(asset?.name || '')) {
      throw new Error(`Unsafe release asset name: ${asset?.name || ''}`);
    }
    const apiUrl = String(asset?.url || '');
    if (!apiUrl.startsWith('https://api.github.com/')) {
      throw new Error(`Untrusted release asset API URL: ${name}`);
    }

    const releaseDir = join(mirrorRoot, releaseTag);
    mkdirSync(releaseDir, { recursive: true, mode: 0o700 });
    const destination = join(releaseDir, name);
    const expectedDigest = digestValue(asset?.digest);
    const expectedSize = Math.max(0, Number(asset?.size || 0));

    if (existsSync(destination)) {
      const size = statSync(destination).size;
      const actualDigest = sha256File(destination);
      if ((!expectedSize || size === expectedSize) && (!expectedDigest || actualDigest === expectedDigest)) {
        return {
          name,
          url: `${publicOrigin}/downloads/releases/${encodeURIComponent(releaseTag)}/${encodeURIComponent(name)}`,
          size,
          digest: `sha256:${actualDigest}`,
        };
      }
    }

    const response = await githubFetch(apiUrl, {
      headers: githubHeaders('application/octet-stream'),
      redirect: 'follow',
    }, assetTimeoutMs);
    if (!response.ok) throw new Error(`GitHub asset download failed (${response.status}): ${name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (expectedSize && bytes.length !== expectedSize) throw new Error(`Release asset size mismatch: ${name}`);
    const actualDigest = sha256Buffer(bytes);
    if (expectedDigest && actualDigest !== expectedDigest) throw new Error(`Release asset SHA-256 mismatch: ${name}`);

    const tmp = `${destination}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o644 });
    renameSync(tmp, destination);
    return {
      name,
      url: `${publicOrigin}/downloads/releases/${encodeURIComponent(releaseTag)}/${encodeURIComponent(name)}`,
      size: bytes.length,
      digest: `sha256:${actualDigest}`,
    };
  }

  async function mirrorRelease(release, stage = 'downloading_latest') {
    const tag = String(release.tag_name || '');
    if (!SAFE_TAG.test(tag)) throw new Error(`Unsafe release tag: ${tag}`);
    if (!isPublicReleaseTag(tag)) throw new Error(`Release ${tag} is below the public release floor`);
    const sourceAssets = Array.isArray(release.assets) ? release.assets : [];
    const active = new Set();
    let completed = 0;

    updateProgress(stage, {
      releaseTag: tag,
      currentAsset: null,
      activeAssets: [],
      completedAssets: 0,
      totalAssets: sourceAssets.length,
    });

    const assets = await Promise.all(sourceAssets.map(async (asset) => {
      const name = String(asset?.name || '');
      active.add(name);
      updateProgress(stage, {
        releaseTag: tag,
        currentAsset: name,
        activeAssets: [...active],
        completedAssets: completed,
        totalAssets: sourceAssets.length,
      });
      try {
        return await downloadAsset(tag, asset);
      } finally {
        active.delete(name);
        completed += 1;
        updateProgress(stage, {
          releaseTag: tag,
          currentAsset: active.size ? [...active][0] : null,
          activeAssets: [...active],
          completedAssets: completed,
          totalAssets: sourceAssets.length,
        });
      }
    }));

    return {
      tag,
      name: String(release.name || tag),
      publishedAt: release.published_at || release.created_at || null,
      assets,
    };
  }

  function logFatal(error) {
    const message = errorText(error);
    if (message !== lastLoggedError) {
      console.warn(`[release-mirror] sync failed transport=${lastTransport || 'none'}: ${message}`);
      lastLoggedError = message;
    }
  }

  function warningForError(message, current) {
    if (/release feed returned 401/i.test(message)) return 'release_token_invalid';
    if (/release feed returned 403/i.test(message)) return 'release_token_forbidden';
    if (storageError) return 'release_mirror_storage_unavailable';
    return current.releases.length ? 'release_mirror_sync_failed' : 'release_feed_unavailable';
  }

  function markFatalSyncError(error) {
    const current = loadIndex();
    lastSyncErrorAt = new Date().toISOString();
    lastSyncError = errorText(error);
    lastWarning = warningForError(lastSyncError, current);
    updateProgress('failed', {
      finishedAt: lastSyncErrorAt,
      activeAssets: [],
      currentAsset: null,
    });
    logFatal(error);
    return publicView(current);
  }

  async function syncOnce() {
    lastSyncAttemptAt = new Date().toISOString();
    historyFailures = [];
    lastTransport = null;
    resetProgress('fetching_release_feed');

    if (!ensureStorage()) throw storageError;
    if (!token) {
      lastWarning = 'private_release_token_required';
      lastSyncErrorAt = lastSyncAttemptAt;
      lastSyncError = 'GPTLOCK_GITHUB_TOKEN or GH_TOKEN is not configured in the running service';
      updateProgress('failed', { finishedAt: lastSyncErrorAt });
      logFatal(new Error(lastSyncError));
      return;
    }

    const response = await githubFetch(RELEASES_API, { headers: githubHeaders() }, 20_000);
    if (!response.ok) throw new Error(`GitHub release feed returned ${response.status}`);
    const rows = safeReleaseRows(await response.json());
    if (!rows.length) throw new Error('GitHub release feed contains no formal releases');

    const previous = loadIndex();
    const rowTags = new Set(rows.map((row) => String(row.tag_name || '')));
    const reusablePrevious = previous.releases.filter((release) => rowTags.has(release.tag) && releaseAssetsAvailable(release));

    const latest = await mirrorRelease(rows[0], 'downloading_latest');
    updateProgress('publishing_latest', {
      releaseTag: latest.tag,
      activeAssets: [],
      currentAsset: null,
      completedAssets: latest.assets.length,
      totalAssets: latest.assets.length,
    });
    const bootstrap = [latest, ...reusablePrevious.filter((release) => release.tag !== latest.tag)].slice(0, 12);
    publishIndex(bootstrap);

    const releases = [latest];
    const historyRows = rows.slice(1);
    for (let index = 0; index < historyRows.length; index += 1) {
      const row = historyRows[index];
      const tag = String(row.tag_name || '');
      updateProgress('backfilling_history', {
        releaseTag: tag,
        historyIndex: index + 1,
        historyTotal: historyRows.length,
      });
      try {
        releases.push(await mirrorRelease(row, 'backfilling_history'));
      } catch (error) {
        const reusable = reusablePrevious.find((release) => release.tag === tag);
        if (reusable) releases.push(reusable);
        historyFailures.push({ tag, error: errorText(error) });
      }
    }

    const final = publishIndex(releases);
    lastSyncSuccessAt = new Date().toISOString();
    lastSyncErrorAt = null;
    lastSyncError = null;
    lastWarning = historyFailures.length ? 'release_history_partial' : null;
    lastLoggedError = null;
    updateProgress('completed', {
      finishedAt: lastSyncSuccessAt,
      releaseTag: final.releases[0]?.tag || latest.tag,
      activeAssets: [],
      currentAsset: null,
      completedAssets: final.releases[0]?.assets?.length || latest.assets.length,
      totalAssets: final.releases[0]?.assets?.length || latest.assets.length,
    });
    if (final.latestVersion && final.latestVersion !== lastLoggedPublishedVersion) {
      console.log(`[release-mirror] published v${final.latestVersion} transport=${lastTransport || 'unknown'} assets=${final.releases[0]?.assets?.length || 0}`);
      lastLoggedPublishedVersion = final.latestVersion;
    }
  }

  async function status() {
    ensureStorage();
    return {
      ...publicView(loadIndex()),
      mirror: {
        root: mirrorRoot,
        tokenConfigured: Boolean(token),
        storageAvailable: !storageError,
        syncInProgress: Boolean(syncing),
        syncIntervalMs,
        fetchRetries,
        assetTimeoutMs,
        minimumPublicRelease: MIN_PUBLIC_RELEASE_TAG,
        privacyCleanupError: privacyCleanupError ? errorText(privacyCleanupError) : null,
        transportPolicy: policy,
        lastTransport,
        proxyConfigured: Boolean(curlTransport?.proxyConfigured),
        proxyInvalid: Boolean(curlTransport?.proxyInvalid),
        lastAttemptAt: lastSyncAttemptAt,
        lastSuccessAt: lastSyncSuccessAt,
        lastErrorAt: lastSyncErrorAt,
        lastError: lastSyncError,
        historyFailures,
        progress: publicProgress(),
      },
    };
  }

  async function sync() {
    if (syncing) {
      await syncing;
      return status();
    }
    syncing = syncOnce().catch((error) => { markFatalSyncError(error); });
    try {
      await syncing;
    } finally {
      syncing = null;
    }
    return status();
  }

  function start() {
    if (timer) return;
    void sync();
    timer = setInterval(() => void sync(), syncIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function waitForChange(since, waitMs = MAX_NOTIFICATION_WAIT_MS) {
    const current = loadIndex();
    const normalizedSince = String(since || '');
    if ((normalizedSince && normalizedSince !== current.generation) || (!normalizedSince && current.releases.length)) {
      return { changed: true, feed: current };
    }
    const timeout = Math.max(0, Math.min(MAX_NOTIFICATION_WAIT_MS, Number(waitMs || 0)));
    if (!timeout) return { changed: false, feed: current };
    return await new Promise((resolveWait) => {
      let settled = false;
      const finish = (feed, changed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        waiters.delete(onChange);
        resolveWait({ changed, feed });
      };
      const onChange = (feed) => finish(feed, true);
      const timeoutId = setTimeout(() => finish(loadIndex(), false), timeout);
      waiters.add(onChange);
    });
  }

  function serveAsset(req, res, pathname) {
    const prefix = '/downloads/releases/';
    if (!String(pathname || '').startsWith(prefix)) return false;
    let tag;
    let name;
    try {
      const parts = pathname.slice(prefix.length).split('/');
      if (parts.length !== 2) return false;
      tag = decodeURIComponent(parts[0]);
      name = decodeURIComponent(parts[1]);
    } catch {
      return false;
    }
    if (!SAFE_TAG.test(tag) || !isPublicReleaseTag(tag) || !SAFE_ASSET.test(name) || basename(name) !== name) return false;
    const feed = loadIndex();
    const release = feed.releases.find((item) => item.tag === tag);
    const asset = release?.assets?.find((item) => item.name === name);
    if (!asset) return false;
    const path = join(mirrorRoot, tag, name);
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    const headers = {
      'content-type': contentType(name),
      'content-length': stat.size,
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      etag: `"${String(asset.digest || '').replace(/^sha256:/, '')}"`,
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(path).pipe(res);
    return true;
  }

  async function load() {
    ensureStorage();
    return publicView(loadIndex());
  }

  function notificationPayload(result) {
    const latest = result.feed.releases[0] || null;
    return {
      ok: true,
      changed: Boolean(result.changed && latest),
      generation: result.feed.generation,
      latestVersion: result.feed.latestVersion,
      publishedAt: latest?.publishedAt || null,
      mirroredAt: result.feed.mirroredAt || null,
    };
  }

  return {
    load,
    status,
    sync,
    start,
    stop,
    waitForChange,
    notificationPayload,
    serveAsset,
    mirrorRoot,
  };
}
