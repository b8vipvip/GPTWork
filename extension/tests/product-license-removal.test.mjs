import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const extensionRoot = fileURLToPath(new URL('..', import.meta.url));
const banned = /GPTL-|GPTLOCK-LICENSE|GPTLOCK_LICENSE|LICENSE_UI_STALE|licenseCode|licenseActivate|licenseKey|验证授权码|获取授权码|授权码激活|授权码校验|授权码清除|授权验证 \/ License/;
const extensions = new Set(['.js', '.html', '.css', '.json']);

async function productionFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (entry.name === 'tests' || entry.name === 'node_modules') continue;
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await productionFiles(filePath));
    else if (extensions.has(extname(entry.name))) output.push(filePath);
  }
  return output;
}

test('legacy product-license protocol and UI cannot return to extension production code', async () => {
  const files = await productionFiles(extensionRoot);
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (banned.test(source)) violations.push(relative(extensionRoot, file));
    banned.lastIndex = 0;
  }
  assert.deepEqual(violations, []);
});
