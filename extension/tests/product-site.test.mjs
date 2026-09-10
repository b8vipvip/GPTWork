import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicRoot = new URL('../../license-server/public/', import.meta.url);

test('public product site exposes dedicated product, guide, releases, and account pages without implementation disclosure', async () => {
  const pages = new Map();
  for (const [file, page] of [['index.html','home'], ['guide.html','guide'], ['releases.html','releases'], ['account.html','account']]) {
    const html = await readFile(new URL(file, publicRoot), 'utf8');
    pages.set(file, html);
    assert.match(html, new RegExp(`data-page="${page}"`));
    assert.match(html, /href="\/guide"/);
    assert.match(html, /href="\/releases"/);
    assert.match(html, /href="\/account"/);
    if (page === 'account') assert.match(html, /src="\/account-commerce\.js"/);
    else assert.match(html, /src="\/site\.js"/);
    assert.match(html, /href="\/site\.css"/);
  }

  const account = pages.get('account.html');
  assert.doesNotMatch(account, /src="\/site\.js"/);
  assert.match(account, /src="\/account-commerce\.js"/);

  const guide = pages.get('guide.html');
  assert.match(guide, /自动验证/);
  assert.match(guide, /选择模型与推理偏好/);
  for (const internalDetail of [
    /Native Core/i,
    /Native Messaging/i,
    /固定扩展 ID/,
    /正式 conversation/i,
    /请求锁定/,
    /响应确认/,
    /响应元数据/,
    /请求字段/,
    /浏览器可见证据/,
  ]) {
    assert.doesNotMatch(pages.get('index.html'), internalDetail);
    assert.doesNotMatch(guide, internalDetail);
    assert.doesNotMatch(pages.get('releases.html'), internalDetail);
  }

  const releaseFeed = await readFile(new URL('../../license-server/site-releases.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(releaseFeed, /notes:\s*String\(release\.body/);
  assert.doesNotMatch(releaseFeed, /html_url/);

  const server = await readFile(new URL('../../license-server/server.mjs', import.meta.url), 'utf8');
  for (const route of ["'/'", "'/guide'", "'/releases'", "'/account'"]) assert.match(server, new RegExp(route.replaceAll('/', '\\/')));
  assert.match(server, /createSiteAccountSystem/);
  assert.match(server, /createSiteReleaseFeed/);
  assert.doesNotMatch(server, /'\/': 'admin\.html'/);
});

test('website account sessions are isolated from extension device quota', async () => {
  const source = await readFile(new URL('../../license-server/site-account.mjs', import.meta.url), 'utf8');
  assert.match(source, /CREATE TABLE IF NOT EXISTS site_sessions/);
  assert.match(source, /gptlock_site_session/);
  assert.doesNotMatch(source, /INSERT INTO user_devices/);
  assert.match(source, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(source, /\/site\/api\/account\/change-password/);
  assert.match(source, /\/site\/api\/account\/devices\/release/);
});

test('extension release button is routed to the GPTWork product site', async () => {
  const source = await readFile(new URL('../options-update.js', import.meta.url), 'utf8');
  assert.match(source, /GPTLOCK_PRODUCT_SITE_URL/);
  assert.match(source, /https:\/\/gptlock\.mv3\.cn\//);
  assert.match(source, /chrome\.tabs\.create\(\{ url: GPTLOCK_PRODUCT_SITE_URL \}\)/);
});
