import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = dirname(SERVER_ROOT);
const RELEASES_HTML = readFileSync(join(SERVER_ROOT, 'public', 'releases.html'), 'utf8');
const CLEANUP_WORKFLOW = readFileSync(join(REPOSITORY_ROOT, '.github', 'workflows', 'release-asset-cleanup.yml'), 'utf8');

test('public releases page keeps only Windows EXE and Linux deb installers', () => {
  assert.match(RELEASES_HTML, /MutationObserver/);
  assert.match(RELEASES_HTML, /Setup-x64\\\.exe/);
  assert.match(RELEASES_HTML, /_amd64\\\.deb/);
  assert.match(RELEASES_HTML, /扩展 ZIP、Core 压缩包、校验清单及其他内部构建文件不会出现在版本列表中/);
});

test('release cleanup removes non-installer GitHub assets after the Release workflow', () => {
  assert.match(CLEANUP_WORKFLOW, /workflow_run:/);
  assert.match(CLEANUP_WORKFLOW, /workflows:\s*\n\s*- Release/);
  assert.match(CLEANUP_WORKFLOW, /gh release delete-asset/);
  assert.match(CLEANUP_WORKFLOW, /Setup-x64\\\.exe/);
  assert.match(CLEANUP_WORKFLOW, /_amd64\\\.deb/);
  assert.match(CLEANUP_WORKFLOW, /Unexpected non-installer release asset remains/);
});
