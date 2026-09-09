import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const extensionRoot = join(repoRoot, 'extension');

function parseArgs(argv) {
  const result = { browser: '', out: '', extensionId: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--browser') result.browser = String(argv[++index] || '').trim().toLowerCase();
    else if (value === '--out') result.out = String(argv[++index] || '').trim();
    else if (value === '--extension-id') result.extensionId = String(argv[++index] || '').trim().toLowerCase();
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!['chrome', 'edge'].includes(result.browser)) throw new Error('--browser must be chrome or edge');
  if (!result.out) throw new Error('--out is required');
  if (result.extensionId && !/^[a-p]{32}$/.test(result.extensionId)) {
    throw new Error('--extension-id must be a 32-character Chrome/Edge extension id using letters a-p');
  }
  return result;
}

function shouldInclude(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('tests/')) return false;
  if ([
    'README.md',
    'package.json',
    'background-update.js',
    'options-update.js',
    'distribution-channel.js',
    'manifest.json',
  ].includes(normalized)) return false;
  return /\.(?:js|css|html|png)$/.test(normalized);
}

function copyRuntimeTree(sourceDir, destinationDir) {
  for (const name of readdirSync(sourceDir)) {
    const source = join(sourceDir, name);
    const rel = relative(extensionRoot, source).replaceAll('\\', '/');
    const destination = join(destinationDir, rel);
    const stat = statSync(source);
    if (stat.isDirectory()) {
      if (rel === 'tests') continue;
      copyRuntimeTree(source, destinationDir);
    } else if (stat.isFile() && shouldInclude(rel)) {
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination);
    }
  }
}

function listingUrl(browser, extensionId) {
  if (!extensionId) return '';
  return browser === 'chrome'
    ? `https://chromewebstore.google.com/detail/${extensionId}`
    : `https://microsoftedge.microsoft.com/addons/detail/${extensionId}`;
}

const args = parseArgs(process.argv.slice(2));
const outputDir = resolve(repoRoot, args.out);
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
copyRuntimeTree(extensionRoot, outputDir);

const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'));
delete manifest.key;
manifest.permissions = Array.isArray(manifest.permissions)
  ? manifest.permissions.filter((permission) => permission !== 'downloads')
  : [];
manifest.background = {
  ...(manifest.background || {}),
  service_worker: 'background-entry-store.js',
  type: 'module',
};
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const settingsPath = join(outputDir, 'settings-v0521.html');
const settings = readFileSync(settingsPath, 'utf8');
const storeSettings = settings.replace(
  '<script type="module" src="options-update.js"></script>',
  '<script type="module" src="store-update-page.js"></script>',
);
if (storeSettings === settings) throw new Error('Could not replace standalone update module in store settings page');
writeFileSync(settingsPath, storeSettings, 'utf8');

const channel = args.browser === 'chrome' ? 'chrome-store' : 'edge-store';
const storeUrl = listingUrl(args.browser, args.extensionId);
writeFileSync(join(outputDir, 'distribution-channel.js'), [
  `export const DISTRIBUTION_CHANNEL = ${JSON.stringify(channel)};`,
  `export const STORE_BROWSER = ${JSON.stringify(args.browser)};`,
  `export const STORE_EXTENSION_ID = ${JSON.stringify(args.extensionId)};`,
  `export const STORE_LISTING_URL = ${JSON.stringify(storeUrl)};`,
  '',
  'export function isStoreManagedExtension() {',
  "  return DISTRIBUTION_CHANNEL === 'chrome-store' || DISTRIBUTION_CHANNEL === 'edge-store';",
  '}',
  '',
].join('\n'), 'utf8');

for (const forbiddenRuntime of ['background-update.js', 'options-update.js']) {
  try {
    statSync(join(outputDir, forbiddenRuntime));
    throw new Error(`Store package unexpectedly contains ${forbiddenRuntime}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const forbidden = [];
function inspect(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const rel = relative(outputDir, path).replaceAll('\\', '/');
    const stat = statSync(path);
    if (stat.isDirectory()) inspect(path);
    else if (/\.rs$/.test(name) || ['Cargo.toml', 'Cargo.lock'].includes(name) || rel.startsWith('private-engine/')) forbidden.push(rel);
  }
}
inspect(outputDir);
if (forbidden.length) throw new Error(`Store package contains private source: ${forbidden.join(', ')}`);

console.log(outputDir);
