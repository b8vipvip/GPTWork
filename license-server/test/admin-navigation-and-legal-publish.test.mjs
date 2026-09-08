import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const ADMIN_PAGES = [
  'admin.html',
  'admin-users.html',
  'admin-plans.html',
  'admin-orders.html',
  'admin-issues.html',
  'admin-website.html',
  'admin-settings.html',
  'admin-client-logs.html',
  'admin-server-logs.html',
  'admin-update.html',
];

test('every admin page exposes Issues and website management and loads the shared navigation runtime', () => {
  for (const filename of ADMIN_PAGES) {
    const html = readFileSync(join(PUBLIC, filename), 'utf8');
    assert.match(html, /href="\/admin\/issues"/, `${filename} should link to Issues`);
    assert.match(html, /href="\/admin\/website"/, `${filename} should link to website management`);
    assert.match(html, /src="\/page-cms\.js"/, `${filename} should load the shared admin navigation runtime`);
  }
});

test('shared admin navigation contains the complete canonical menu', () => {
  const source = readFileSync(join(PUBLIC, 'page-cms.js'), 'utf8');
  for (const route of ['/admin/overview', '/admin/users', '/admin/plans', '/admin/orders', '/admin/issues', '/admin/website', '/admin/settings', '/admin/client-logs', '/admin/server-logs', '/admin/update']) {
    assert.ok(source.includes(route), `shared navigation should contain ${route}`);
  }
});

test('system settings stylesheet is linked, served and contains the official-payment layout', () => {
  const html = readFileSync(join(PUBLIC, 'admin-settings.html'), 'utf8');
  const css = readFileSync(join(PUBLIC, 'admin-settings.css'), 'utf8');
  const serverSource = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  assert.match(html, /href="\/admin-settings\.css"/, 'system settings should load its dedicated stylesheet');
  assert.match(serverSource, /url\.pathname === '\/admin-settings\.css'/, 'server should expose the dedicated system settings stylesheet');
  assert.match(css, /\.settings-subnav\{/i, 'system settings should include the sticky section navigation styling');
  assert.match(css, /\.official-payment-grid\{/i, 'system settings should include the official payment provider grid styling');
  assert.match(css, /@media\(max-width:820px\)/i, 'system settings payment layout should remain responsive on narrow screens');
});

test('website CMS publishes fields directly without a global save-all action', () => {
  const html = readFileSync(join(PUBLIC, 'admin-website.html'), 'utf8');
  const source = readFileSync(join(PUBLIC, 'admin-website.js'), 'utf8');
  const css = readFileSync(join(PUBLIC, 'admin-website.css'), 'utf8');

  assert.doesNotMatch(html, /id="saveWebsite"/, 'global save-all action should be removed');
  assert.doesNotMatch(html, />全部保存并发布</, 'save-all wording should be removed');
  assert.match(source, /persisted:\s*null/, 'website editor should retain a last-published snapshot');
  assert.match(source, /async function persistPaths\(/, 'website editor should support path-scoped saves');
  assert.match(source, /const next = clone\(state\.persisted\)/, 'field save should begin from the published snapshot, not all local edits');
  assert.match(source, /verifyPublicPaths/, 'admin saves should verify the public website API reflects the persisted field');
  assert.match(source, /scheduleAutoPersist/, 'style selections should be auto-persisted');
  assert.match(source, /cms-field-save/, 'website text fields should render their own save controls');
  assert.match(css, /\.cms-field-footer/, 'field save controls should have an explicit non-overlapping layout');
});

test('website CMS separates global, home and per-page editors behind top navigation', () => {
  const html = readFileSync(join(PUBLIC, 'admin-website.html'), 'utf8');
  const source = readFileSync(join(PUBLIC, 'admin-website.js'), 'utf8');
  for (const view of ['global','home','guide','releases','issues','support','account','legal']) {
    assert.match(html, new RegExp(`data-cms-view="${view}"`), `website manager should expose ${view} view`);
  }
  assert.match(html, /id="websiteGlobalView"/);
  assert.match(html, /id="websiteHomeView"[^>]*hidden/);
  assert.match(html, /id="websitePageView"[^>]*hidden/);
  assert.match(html, /id="websiteLegalView"[^>]*hidden/);
  assert.match(source, /OPERATIONAL_VIEWS = \['guide', 'releases', 'issues', 'support', 'account'\]/);
  assert.match(source, /renderCurrentPage\(\)/);
  assert.doesNotMatch(source, /for \(const \[key, page\] of Object\.entries\(state\.config\.pages/);
});

test('legal CMS removes the old draft action row and publishes individual fields directly', () => {
  const html = readFileSync(join(PUBLIC, 'admin-website.html'), 'utf8');
  const source = readFileSync(join(PUBLIC, 'page-cms.js'), 'utf8');
  for (const legacyId of ['saveLegalDraft', 'compareLegal', 'restoreLegalDraft', 'publishLegal']) {
    assert.doesNotMatch(html, new RegExp(`id="${legacyId}"`), `${legacyId} should be removed from Legal CMS`);
  }
  assert.match(source, /async function saveLegalField\(/, 'Legal CMS should have field-scoped save/publish behavior');
  assert.match(source, /const next = \{ \.\.\.item\.published\.document, \[field\]: pending\[field\] \}/, 'legal save should start from the published document and replace only one field');
  assert.match(source, /\/publish`, \{ method: 'POST'/, 'legal field save should publish immediately');
  assert.match(source, /\/restore`, \{ method: 'POST'/, 'failed legal publish should restore the server draft');
  for (const field of ['browserTitle','description','eyebrow','title','subtitle','content']) {
    assert.ok(source.includes(`${field}:`), `Legal CMS should expose a save control mapping for ${field}`);
  }
});

test('Issues admin UI exposes first-class administrator post creation and improved editing', () => {
  const html = readFileSync(join(PUBLIC, 'admin-issues.html'), 'utf8');
  const source = readFileSync(join(PUBLIC, 'admin-issues.js'), 'utf8');
  assert.match(html, /id="newAdminIssue"/, 'Issues admin should expose administrator post creation');
  assert.match(html, /id="createCard"/, 'Issues admin should include the administrator composer');
  assert.match(html, /id="editStatus"/, 'Issue editor should edit status directly');
  assert.match(html, /id="editPinned"/, 'Issue editor should edit pinned state directly');
  assert.match(html, /id="editPreview"/, 'Issue editor should provide a body preview');
  assert.match(source, /api\('\/admin\/api\/issues',\{method:'POST'/, 'administrator composer should use the admin create endpoint');
  assert.match(source, /event\.ctrlKey\|\|event\.metaKey/, 'Issue editor should support Ctrl/Cmd+S');
});
