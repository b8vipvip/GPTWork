import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readExtensionFile = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('popup renders an explicit account level prefix and a styled upgrade CTA', async () => {
  const [html, css] = await Promise.all([
    readExtensionFile('popup-v0513.html'),
    readExtensionFile('popup.css'),
  ]);

  assert.match(html, /class="account-tier-display"><span class="account-tier-prefix">等级：<\/span><span id="accountTier">/);
  assert.match(html, /id="accountUpgrade" class="account-upgrade"/);
  assert.match(css, /\.account-tier-display\{[^}]*font-size:10\.5px[^}]*font-weight:800/s);
  assert.match(css, /\.account-upgrade\{[^}]*background:linear-gradient\([^}]*#f97316[^}]*color:#fff[^}]*border-radius:999px/s);
});

test('account center mirrors the same level wording and upgrade CTA treatment', async () => {
  const [html, css] = await Promise.all([
    readExtensionFile('account.html'),
    readExtensionFile('account.css'),
  ]);

  assert.match(html, /class="tier-display"><span class="tier-prefix">等级：<\/span><strong id="tier">/);
  assert.match(html, /id="upgradeButton" class="upgrade-link"/);
  assert.match(css, /\.tier-display\{[^}]*font-size:14px[^}]*font-weight:800/s);
  assert.match(css, /\.upgrade-link\{[^}]*background:linear-gradient\([^}]*#f97316[^}]*color:#fff[^}]*border-radius:999px/s);
});
