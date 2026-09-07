import { readFile, writeFile, rm } from 'node:fs/promises';

const from = '0.5.45';
const to = '0.5.46';

async function replaceExact(path, before, after) {
  const source = await readFile(path, 'utf8');
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one ${JSON.stringify(before)}, got ${count}`);
  await writeFile(path, source.replace(before, after), 'utf8');
}

await replaceExact('extension/manifest.json', `"version": "${from}"`, `"version": "${to}"`);
await replaceExact('extension/package.json', `"version": "${from}"`, `"version": "${to}"`);
await replaceExact('native-core/Cargo.toml', `version = "${from}"`, `version = "${to}"`);

await rm('scripts/prepare-release-v0.5.46.mjs', { force: true });
await rm('.github/workflows/prepare-release-v0.5.46.yml', { force: true });
console.log(`Prepared GPTWork v${to} source versions`);
