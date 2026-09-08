import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/admin-website.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/admin-website.html', import.meta.url), 'utf8');

test('website navigation and rich text editors use non-overlapping responsive layouts', () => {
  assert.match(css, /\.nav-row\{display:block\}/);
  assert.match(css, /\.nav-fields\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1\.25fr\) minmax\(140px,\.45fr\)/);
  assert.match(css, /\.nested-item\{[^}]*grid-template-columns:1fr/);
  assert.match(css, /\.cms-field\{[^}]*grid-template-areas:"label label" "toolbar toolbar" "control footer" "help help"/);
  assert.match(css, /\.cms-field-footer\{[^}]*position:static!important/);
  assert.match(css, /\.cms-style-toolbar\{[^}]*width:100%/);
  assert.match(css, /@media\(max-width:900px\)/);
  assert.doesNotMatch(css, /\.cms-field:has\(textarea\)>.cms-field-footer\{position:absolute/);
  assert.match(html, /class="website-view-tabs"/);
});
