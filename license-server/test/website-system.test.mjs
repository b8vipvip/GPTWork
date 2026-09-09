import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createWebsiteSystem, DEFAULT_WEBSITE_CONFIG, normalizeWebsiteConfig } from '../website-system.mjs';

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, license_id INTEGER, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL) STRICT;
  `);
  return db;
}

test('website config keeps required modules, sanitizes links, and migrates operational pages', () => {
  const config = normalizeWebsiteConfig({
    schemaVersion: 1,
    site: { brandName: ' My GPTWork ', title: 'Custom title', styles: { brandName: { font: 'georgia', size: 24, color: '#AABBCC', background: 'url(javascript:1)', bold: true, underline: true } } },
    navigation: [
      { id: 'bad', label: 'Bad', href: 'javascript:alert(1)', enabled: true, order: 3 },
      { id: 'docs', label: 'Docs', href: 'https://example.com/docs', enabled: true, order: 2 },
    ],
    homeModules: [
      { id: 'hero', type: 'hero', enabled: false, order: 90, title: 'Changed', body: 'Body' },
      { id: 'custom-one', type: 'custom', name: '自定义', enabled: true, order: 5, title: 'Hello', body: 'World', buttonLabel: 'Go', buttonHref: 'javascript:bad()' },
    ],
  });
  assert.equal(config.schemaVersion, 3);
  assert.equal(config.site.brandName, 'My GPTWork');
  assert.deepEqual(config.site.styles.brandName, { font: 'georgia', size: 24, color: '#aabbcc', bold: true, underline: true });
  assert.equal(config.navigation[0].href, '/');
  assert.equal(config.navigation[1].href, 'https://example.com/docs');
  assert.equal(config.homeModules.find((item) => item.id === 'hero').enabled, false);
  assert.equal(config.homeModules.find((item) => item.id === 'custom-one').buttonHref, '/');
  for (const required of ['hero', 'features', 'workflow', 'callout']) assert.ok(config.homeModules.some((item) => item.id === required));
  for (const page of ['guide', 'releases', 'issues', 'support', 'account']) assert.ok(config.pages[page]);
  assert.equal(config.pages.guide.modules.find((item) => item.id === 'guide-steps').type, 'guide-steps');
  assert.equal(config.pages.guide.modules.find((item) => item.id === 'guide-steps').items.length, 7);
  assert.equal(config.pages.issues.modules.find((item) => item.id === 'issues-detail').type, 'protected');
  assert.equal(config.pages.account.modules.find((item) => item.id === 'account-dashboard').type, 'protected');
});

test('protected page module identity and type cannot be rewritten by stored configuration', () => {
  const config = normalizeWebsiteConfig({
    pages: {
      account: {
        browserTitle: 'Custom account',
        hero: { title: 'My account' },
        modules: [
          { id: 'account-login', type: 'callout', name: 'Injected', enabled: false, order: 99, title: '<script>x</script>' },
          { id: 'evil-extra', type: 'protected', enabled: true, order: 1 },
        ],
      },
      guide: {
        modules: [
          { id: 'guide-steps', type: 'protected', enabled: true, items: [{ title: '自定义第一步', body: '自定义说明' }] },
          { id: 'guide-callout', type: 'callout', enabled: true, buttonHref: 'javascript:alert(1)' },
        ],
      },
    },
  });
  const login = config.pages.account.modules.find((item) => item.id === 'account-login');
  assert.equal(login.type, 'protected');
  assert.equal(login.name, '账户登录');
  assert.equal(login.enabled, false);
  assert.equal(login.order, 99);
  assert.equal(config.pages.account.modules.some((item) => item.id === 'evil-extra'), false);
  const guideSteps = config.pages.guide.modules.find((item) => item.id === 'guide-steps');
  assert.equal(guideSteps.type, 'guide-steps');
  assert.equal(guideSteps.items[0].title, '自定义第一步');
  assert.equal(guideSteps.items[0].body, '自定义说明');
  assert.equal(config.pages.guide.modules.find((item) => item.id === 'guide-callout').buttonHref, '/releases');
});

test('website system seeds defaults, persists page updates, and can reset', async () => {
  const db = createDb();
  const json = (res, status, body) => { res.status = status; res.body = body; };
  const system = createWebsiteSystem({ db, json });
  const seeded = system.read();
  assert.equal(seeded.config.site.brandName, 'GPTWork');
  assert.equal(seeded.config.schemaVersion, 3);
  assert.ok(seeded.updatedAt);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM app_settings').get().count, 1);

  const res = {};
  const input = structuredClone(DEFAULT_WEBSITE_CONFIG);
  input.site.brandName = 'GPTWork Pro';
  input.homeModules[1].enabled = false;
  input.pages.guide.hero.title = '新的教程标题';
  input.pages.guide.modules.find((item) => item.id === 'guide-steps').items[0].title = '管理员编辑后的安装步骤';
  input.pages.issues.modules.find((item) => item.id === 'issues-new').enabled = false;
  await system.handleAdmin({ method: 'PUT' }, res, new URL('https://example.test/admin/api/website'), async () => ({ config: input }));
  assert.equal(res.status, 200);
  assert.equal(system.read().config.site.brandName, 'GPTWork Pro');
  assert.equal(system.read().config.homeModules.find((item) => item.id === 'features').enabled, false);
  assert.equal(system.read().config.pages.guide.hero.title, '新的教程标题');
  assert.equal(system.read().config.pages.guide.modules.find((item) => item.id === 'guide-steps').items[0].title, '管理员编辑后的安装步骤');
  assert.equal(system.read().config.pages.issues.modules.find((item) => item.id === 'issues-new').enabled, false);

  const auditDetail = JSON.parse(db.prepare("SELECT detail FROM audit_log WHERE event='website_config_updated' ORDER BY id DESC LIMIT 1").get().detail);
  assert.equal(auditDetail.pages, 5);

  const resetRes = {};
  await system.handleAdmin({ method: 'POST' }, resetRes, new URL('https://example.test/admin/api/website/reset'), async () => ({}));
  assert.equal(resetRes.status, 200);
  assert.equal(system.read().config.site.brandName, 'GPTWork');
  assert.equal(system.read().config.homeModules.find((item) => item.id === 'features').enabled, true);
  assert.equal(system.read().config.pages.guide.modules.find((item) => item.id === 'guide-steps').items[0].title, '安装 GPTWork');
  assert.equal(system.read().config.pages.issues.modules.find((item) => item.id === 'issues-new').enabled, true);
  const events = db.prepare('SELECT event FROM audit_log ORDER BY id').all().map((row) => row.event);
  assert.deepEqual(events, ['website_config_initialized', 'website_config_updated', 'website_config_reset']);
});
