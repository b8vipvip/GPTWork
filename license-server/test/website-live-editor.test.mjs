import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');

test('public CMS watches website config changes and refreshes already-open pages', () => {
  const source = readFileSync(join(PUBLIC, 'rich-text-style.js'), 'utf8');
  assert.match(source, /installPublicCmsLiveReload/);
  assert.match(source, /\/site\/api\/website\?_=/);
  assert.match(source, /cache: 'no-store'/);
  assert.match(source, /setInterval\(\(\) => void check\(\), 3000\)/);
  assert.match(source, /location\.reload\(\)/);
});

test('website manager verifies public config after each field-scoped save', () => {
  const source = readFileSync(join(PUBLIC, 'admin-website.js'), 'utf8');
  assert.match(source, /async function verifyPublicPaths\(paths\)/);
  assert.match(source, /await verifyPublicPaths\(uniquePaths\)/);
  assert.match(source, /\/site\/api\/website\?_=/);
});
