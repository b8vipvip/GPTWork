import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import test from 'node:test';

const extensionRoot = new URL('..', import.meta.url);
const banned = /GPTL-|GPTLOCK-LICENSE|GPTLOCK_LICENSE|LICENSE_UI_STALE|licenseCode|licenseActivate|验证授权码|获取授权码|授权验证 \/ License/;
const extensions = new Set(['.js', '.html', '.css', '.json']);

async function productionFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (entry.name === 'tests') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await productionFiles(path));
    else if (extensions.has(extname(entry.name))) output.push(path);
  }
  return output;
}

test('legacy product-license protocol and UI cannot return to extension production code', async () => {
  const files = await productionFiles(extensionRoot);
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (banned.test(source)) violations.push(file);
  }
  assert.deepEqual(violations, []);
});
