import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');

function read(name) { return readFileSync(join(PUBLIC, name), 'utf8'); }

test('public Issues page links to a dedicated composer instead of embedding the old form', () => {
  const html = read('issues.html');
  assert.match(html, /id="newIssueEntry"[^>]+href="\/issues\/new"/);
  assert.match(html, /id="newIssueCard"/, 'CMS protected Issues-new module should still have a stable target');
  assert.doesNotMatch(html, /id="newIssueTitle"/);
  assert.doesNotMatch(html, /id="newIssueBody"/);
});

test('dedicated Issue composer exposes admin-only privacy and keeps local draft support', () => {
  const html = read('issues-new.html');
  const js = read('issues-new.js');
  assert.match(html, /id="newIssueAdminOnly"[^>]+type="checkbox"/);
  assert.match(html, /仅管理员可见/);
  assert.match(html, /不会出现在公开列表、搜索或公开详情页/);
  assert.match(js, /adminOnly:\s*\$\('newIssueAdminOnly'\)\.checked/);
  assert.match(js, /gptwork_issue_draft_v1/);
  assert.match(js, /location\.assign\(`\/issues\?id=/);
  assert.match(js, /issueCreatedPrivate/);
});

test('server exposes the dedicated composer page and script', () => {
  const server = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  assert.match(server, /'\/issues\/new':'issues-new\.html'/);
  assert.match(server, /url\.pathname === '\/issues-new\.js'/);
});

test('website CMS save controls use explicit non-overlapping field layout', () => {
  const css = read('admin-website.css');
  const html = read('admin-website.html');
  assert.match(css, /\.cms-field-save\{[^}]*background:#16a34a!important[^}]*color:#fff!important/);
  assert.match(css, /\.cms-field\{[^}]*grid-template-columns:minmax\(0,1fr\) auto[^}]*grid-template-areas:"label label" "toolbar toolbar" "control footer" "help help"/);
  assert.match(css, /\.cms-field-footer\{[^}]*position:static!important/);
  assert.match(css, /\.cms-field>textarea\{[^}]*resize:vertical/);
  assert.match(css, /\.cms-field>input\[type=number\]\{[^}]*max-width:130px!important/);
  assert.doesNotMatch(css, /\.cms-field:has\(textarea\)>\.cms-field-footer\{[^}]*position:absolute/);
  assert.doesNotMatch(css, /#saveWebsite\{/);
  assert.doesNotMatch(html, /id="saveWebsite"/);
  assert.match(html, /文本字段点击绿色“保存”后立即写入公开配置/);
  assert.match(html, /开关和文本样式选择会自动保存/);
});
