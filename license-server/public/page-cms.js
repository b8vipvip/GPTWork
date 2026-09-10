const cmsRichTextPromise = import('/rich-text-style.js').catch(() => null);

(() => {
  const current = document.body.dataset.adminPage || '';
  const nav = document.querySelector('.sidebar nav');
  if (!current || !nav) return;
  const items = [
    ['overview', '/admin/overview', '总览'],
    ['users', '/admin/users', '用户'],
    ['plans', '/admin/plans', '用户配置'],
    ['orders', '/admin/orders', '订单'],
    ['issues', '/admin/issues', 'Issues 讨论区'],
    ['website', '/admin/website', '官网管理'],
    ['settings', '/admin/settings', '系统配置'],
    ['client-logs', '/admin/client-logs', '客户端运行日志'],
    ['server-logs', '/admin/server-logs', '服务端日志'],
    ['update', '/admin/update', '更新'],
  ];
  nav.replaceChildren(...items.map(([page, href, label]) => {
    const link = document.createElement('a');
    link.href = href; link.dataset.page = page; link.textContent = label;
    if (page === current) { link.classList.add('active'); link.setAttribute('aria-current', 'page'); }
    return link;
  }));
})();

(() => {
  const page = document.body.dataset.page || '';
  const legalKey = document.body.dataset.legalKey || '';
  const operationalPages = ['guide','releases','issues','support','account'];
  const legalPages = ['privacy','terms','data-deletion'];
  if (!operationalPages.includes(page) && !legalPages.includes(legalKey)) return;

  function qs(selector, root = document) { return root.querySelector(selector); }
  let richText = null;
  function setText(node, value, style = {}) { if (!node || value === undefined || value === null) return; node.textContent = String(value); node.style.whiteSpace = 'pre-line'; richText?.applyTextStyle(node, style); }
  function safeHref(value) {
    const href = String(value || '');
    if (/^\/(?!\/)[^\s]*$/.test(href)) return href;
    try { const url = new URL(href); if (url.protocol === 'https:') return url.toString(); } catch {}
    return '';
  }
  function appendInline(parent, source) {
    const text = String(source || '');
    const token = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
    let cursor = 0; let match;
    while ((match = token.exec(text))) {
      if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
      if (match[2] !== undefined) { const strong = document.createElement('strong'); strong.textContent = match[2]; parent.append(strong); }
      else if (match[3] !== undefined) { const code = document.createElement('code'); code.textContent = match[3]; parent.append(code); }
      else {
        const href = safeHref(match[5]);
        if (href) { const link = document.createElement('a'); link.textContent = match[4]; link.href = href; if (href.startsWith('https://')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; } parent.append(link); }
        else parent.append(document.createTextNode(match[4]));
      }
      cursor = token.lastIndex;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }
  function renderLegalMarkdown(container, content) {
    const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
    container.replaceChildren();
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i += 1; continue; }
      if (line.startsWith('## ')) { const h2 = document.createElement('h2'); appendInline(h2, line.slice(3)); container.append(h2); i += 1; continue; }
      if (line.startsWith('> ')) {
        const box = document.createElement('div'); box.className = 'box';
        let first = true;
        while (i < lines.length && lines[i].startsWith('> ')) {
          let value = lines[i].slice(2);
          if (first) {
            const danger = value.match(/^\[!DANGER\]\s*/); const note = value.match(/^\[!NOTE\]\s*/);
            if (danger) { box.classList.add('danger'); value = value.slice(danger[0].length); }
            else if (note) value = value.slice(note[0].length);
            const strong = document.createElement('strong'); appendInline(strong, value); box.append(strong);
          } else { const p = document.createElement('p'); appendInline(p, value); box.append(p); }
          first = false; i += 1;
        }
        container.append(box); continue;
      }
      if (/^-\s+/.test(line)) {
        const ul = document.createElement('ul');
        while (i < lines.length && /^-\s+/.test(lines[i])) { const li = document.createElement('li'); appendInline(li, lines[i].replace(/^-\s+/, '')); ul.append(li); i += 1; }
        container.append(ul); continue;
      }
      if (/^\d+\.\s+/.test(line)) {
        const ol = document.createElement('ol');
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { const li = document.createElement('li'); appendInline(li, lines[i].replace(/^\d+\.\s+/, '')); ol.append(li); i += 1; }
        container.append(ol); continue;
      }
      const paragraphLines = [];
      while (i < lines.length && lines[i].trim() && !lines[i].startsWith('## ') && !lines[i].startsWith('> ') && !/^-\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])) { paragraphLines.push(lines[i].trim()); i += 1; }
      const p = document.createElement('p'); appendInline(p, paragraphLines.join(' ')); container.append(p);
    }
  }

  async function loadLegal() {
    richText = await cmsRichTextPromise;
    const response = await fetch(`/site/api/legal/${encodeURIComponent(legalKey)}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json().catch(() => null); const doc = data?.document; if (!doc) return;
    if (doc.browserTitle) document.title = doc.browserTitle;
    let meta = qs('meta[name="description"]'); if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.append(meta); }
    if (doc.description) meta.content = doc.description;
    const main = qs('main.legal'); if (!main) return;
    main.replaceChildren();
    const eyebrow = document.createElement('span'); eyebrow.className = 'eyebrow'; setText(eyebrow, doc.eyebrow || '', doc.styles?.eyebrow);
    const h1 = document.createElement('h1'); const titleText = document.createElement('span'); setText(titleText, doc.title || '', doc.styles?.title); h1.append(titleText);
    if (doc.subtitle) { h1.append(document.createElement('br')); const small = document.createElement('small'); setText(small, doc.subtitle, doc.styles?.subtitle); h1.append(small); }
    const metaLine = document.createElement('p'); metaLine.className = 'meta'; metaLine.textContent = `最后更新 / Last updated: ${doc.lastUpdated || '—'} · v${Number(data.version || 0)}`;
    const body = document.createElement('div'); body.dataset.legalPublishedVersion = String(data.version || 0); renderLegalMarkdown(body, doc.content || ''); richText?.applyTextStyle(body, doc.styles?.content);
    main.append(eyebrow, h1, metaLine, body);
  }

  async function loadOperational() {
    richText = await cmsRichTextPromise;
    const response = await fetch('/site/api/website', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json().catch(() => null); const config = data?.config; const current = config?.pages?.[page];
    if (!current) return;
    if (current.browserTitle) document.title = current.browserTitle;
    let meta = qs('meta[name="description"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.append(meta); }
    if (current.description) meta.content = current.description;
    applyHero(current.hero || {}); applyModules(current.modules || []);
  }
  function heroRoot() { if (['guide','releases','account'].includes(page)) return qs('.page-hero'); if (['issues','support'].includes(page)) return qs('main.support'); return null; }
  function applyHero(hero) {
    const root = heroRoot(); if (!root) return; setText(qs('.eyebrow', root), hero.eyebrow, hero.styles?.eyebrow); const h1 = qs('h1', root); if (h1 && hero.title) setText(h1, hero.title, hero.styles?.title);
    let body = null; if (['guide','releases','account'].includes(page)) body = qs(':scope > p', root); else body = [...root.children].find((node) => node.tagName === 'P'); if (body && hero.body) setText(body, hero.body, hero.styles?.body);
  }
  function targetFor(id) {
    if (page === 'guide') { const sections = [...document.querySelectorAll('main > section')]; return id === 'guide-steps' ? sections[1] : id === 'guide-callout' ? sections[2] : null; }
    if (page === 'releases') { const sections = [...document.querySelectorAll('main > section')]; return id === 'release-feed' ? sections[1] : null; }
    if (page === 'issues') { const main = qs('main.support'); if (id === 'issues-search') return [...(main?.children || [])].find((node) => node.classList?.contains('release-card') && node.id !== 'newIssueCard' && node.id !== 'issueDetail') || null; if (id === 'issues-new') return qs('#newIssueCard'); if (id === 'issues-detail') return qs('#issueDetail'); if (id === 'issues-list') return qs('#issueListWrap'); }
    if (page === 'support') { if (id === 'support-links') return qs('main.support > .cards'); if (id === 'support-warning') return qs('main.support > .warn'); }
    if (page === 'account') { if (id === 'account-login') return qs('#loginCard'); if (id === 'account-dashboard') return qs('.account-layout > section.account-card'); }
    return null;
  }
  function moduleRoot() { if (page === 'guide' || page === 'releases') return qs('main'); if (page === 'issues' || page === 'support') return qs('main.support'); if (page === 'account') return qs('.account-layout'); return null; }
  function applyCallout(target, module) { if (!target) return; setText(qs('h2', target), module.title, module.styles?.title); setText(qs('p', target), module.body, module.styles?.body); const link = qs('a.btn', target); if (link) { setText(link, module.buttonLabel, module.styles?.buttonLabel); if (module.buttonHref) link.href = module.buttonHref; } }
  function applyModules(modules) {
    const sorted = [...modules].sort((a, b) => Number(a.order) - Number(b.order)); const root = moduleRoot();
    for (const module of sorted) { const target = targetFor(module.id); if (!target) continue; if (!module.enabled) target.style.display = 'none'; else target.style.removeProperty('display'); target.dataset.cmsPageModule = module.id; if (module.type === 'callout') applyCallout(target, module); }
    if (!root || page === 'support') return; for (const module of sorted) { if (module.lockedOrder) continue; const target = targetFor(module.id); if (target && target.parentElement === root) root.append(target); }
  }

  if (legalPages.includes(legalKey)) void loadLegal().catch(() => {}); else void loadOperational().catch(() => {});
})();

(() => {
  if (document.body.dataset.adminPage !== 'website') return;
  const $ = (id) => document.getElementById(id);
  const legalState = { documents: [], active: 'privacy', loaded: false };
  let richText = null; const styledFields = ['eyebrow','title','subtitle','content'];
  const editableFields = ['browserTitle','description','eyebrow','title','subtitle','content'];
  const fieldControls = {
    browserTitle:'legalBrowserTitle', description:'legalDescription', eyebrow:'legalEyebrow', title:'legalTitle', subtitle:'legalSubtitle', content:'legalContent',
  };
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw Object.assign(new Error(body.error?.message || `HTTP ${response.status}`), { status: response.status });
    return body;
  }
  function node(tag, className = '', text = '') { const el = document.createElement(tag); if (className) el.className = className; if (text !== '') el.textContent = text; return el; }
  function msg(value, tone = '') { const el = $('legalMessage'); if (!el) return; el.textContent = value || ''; el.className = `message ${tone}`.trim(); }
  function date(value) { const d = new Date(value || ''); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false }); }
  function current() { return legalState.documents.find((item) => item.key === legalState.active) || legalState.documents[0] || null; }
  function replace(data) { const index = legalState.documents.findIndex((item) => item.key === data.key); if (index >= 0) legalState.documents[index] = data; else legalState.documents.push(data); }
  function collect() {
    const item = current(); if (!item) return null;
    item.draft = { ...item.draft, styles: { ...(item.draft.styles || {}) }, browserTitle: $('legalBrowserTitle').value, description: $('legalDescription').value, eyebrow: $('legalEyebrow').value, title: $('legalTitle').value, subtitle: $('legalSubtitle').value, content: $('legalContent').value };
    return { ...item.draft, styles: { ...(item.draft.styles || {}) } };
  }
  function legalStyle(item, field) { item.draft.styles ||= {}; item.draft.styles[field] ||= {}; return item.draft.styles[field]; }
  function refreshLegalStyleEditors(item) {
    if (!richText) return;
    for (const field of styledFields) {
      const control = $(fieldControls[field]); const label = control?.closest('label'); if (!control || !label) continue;
      label.querySelector(':scope > .cms-style-toolbar')?.remove(); label.classList.add('has-rich-style');
      const toolbar = richText.createTextStyleToolbar({ control, value: legalStyle(item, field), onChange: (next) => { item.draft.styles[field] = next; } });
      label.insertBefore(toolbar, control);
    }
  }
  function localMerge(data, pending, savedField = null) {
    const merged = { ...data, draft: { ...data.published.document, styles: { ...(data.published.document.styles || {}), ...(pending.styles || {}) } } };
    for (const field of editableFields) merged.draft[field] = pending[field] ?? merged.draft[field];
    if (savedField) { merged.draft[savedField] = data.published.document[savedField]; if (styledFields.includes(savedField)) merged.draft.styles[savedField] = data.published.document.styles?.[savedField] || {}; }
    merged.draft.lastUpdated = data.published.document.lastUpdated;
    merged.dirty = editableFields.some((field) => String(merged.draft[field] ?? '') !== String(data.published.document[field] ?? '')) || styledFields.some((field) => JSON.stringify(merged.draft.styles?.[field] || {}) !== JSON.stringify(data.published.document.styles?.[field] || {}));
    return merged;
  }
  function docLines(doc) {
    const body = String(doc?.content || '').split('\n'); const limited = body.length > 400 ? [...body.slice(0, 400), `… 已截断，正文共 ${body.length} 行 …`] : body;
    return [`浏览器标题: ${doc?.browserTitle || ''}`, `SEO: ${doc?.description || ''}`, `顶部短标题: ${doc?.eyebrow || ''}`, `主标题: ${doc?.title || ''}`, `副标题: ${doc?.subtitle || ''}`, `文本样式: ${JSON.stringify(doc?.styles || {})}`, `Last updated: ${doc?.lastUpdated || ''}`, '', ...limited];
  }
  function lineDiff(before, after) {
    const a = docLines(before), b = docLines(after); const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = []; let i = 0; let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { out.push(['same', a[i]]); i += 1; j += 1; }
      else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) { out.push(['add', b[j]]); j += 1; }
      else { out.push(['remove', a[i]]); i += 1; }
    }
    return out;
  }
  function renderDiff(before, after, title = '当前已发布版本 ↔ 当前编辑') {
    const wrap = $('legalDiff'); if (!wrap) return; wrap.replaceChildren(node('div', 'legal-diff-title', title)); const lines = node('div', 'legal-diff-lines');
    for (const [type, text] of lineDiff(before, after)) { const row = node('div', `legal-diff-line ${type}`); row.append(node('span', 'legal-diff-mark', type === 'add' ? '+' : type === 'remove' ? '−' : ' '), node('code', '', text || ' ')); lines.append(row); }
    wrap.append(lines);
  }
  function arm(button, label, action) {
    const now = Date.now(); if (Number(button.dataset.confirmUntil || 0) > now) { button.dataset.confirmUntil = '0'; button.textContent = button.dataset.original || button.textContent; return void action(); }
    button.dataset.original ||= button.textContent; button.dataset.confirmUntil = String(now + 5000); button.textContent = label;
    setTimeout(() => { if (Number(button.dataset.confirmUntil || 0) <= Date.now()) { button.textContent = button.dataset.original; button.dataset.confirmUntil = '0'; } }, 5100);
  }
  function tabs() {
    const wrap = $('legalTabs'); if (!wrap) return; wrap.replaceChildren();
    for (const item of legalState.documents) { const b = node('button', item.key === legalState.active ? 'primary' : '', `${item.name}${item.dirty ? ' *' : ''}`); b.type = 'button'; b.addEventListener('click', () => { collect(); legalState.active = item.key; render(); }); wrap.append(b); }
  }
  function history(item) {
    const wrap = $('legalHistory'); wrap.replaceChildren();
    for (const entry of item.history || []) {
      const row = node('div', 'legal-history-row'); const info = node('div'); const action = entry.action === 'rollback' ? `回滚自 v${entry.sourceVersion}` : entry.action === 'seed' ? '初始版本' : '发布'; info.append(node('strong', '', `v${entry.version} · ${action}`), node('small', '', date(entry.publishedAt)));
      const actions = node('div', 'module-controls'); const compare = node('button', '', '与当前编辑对比'); compare.type = 'button'; compare.addEventListener('click', async () => { try { collect(); const data = await api(`/admin/api/legal/${item.key}/version?version=${entry.version}`); renderDiff(data.document, item.draft, `历史 v${entry.version} ↔ 当前编辑`); } catch (error) { msg(error.message, 'bad'); } }); actions.append(compare);
      if (entry.version !== item.published.version) { const rollback = node('button', 'danger', '回滚到此版本'); rollback.type = 'button'; rollback.addEventListener('click', () => arm(rollback, '再次点击确认回滚并发布', async () => { try { const data = await api(`/admin/api/legal/${item.key}/rollback`, { method: 'POST', body: JSON.stringify({ version: entry.version, confirmation: `ROLLBACK:${item.key}` }) }); replace(data); render(); msg(`已基于 v${entry.version} 发布新的 v${data.published.version}，历史版本未被覆盖。`, 'good'); } catch (error) { msg(error.message, 'bad'); } })); actions.append(rollback); }
      row.append(info, actions); wrap.append(row);
    }
  }
  function render() {
    const item = current(); if (!item || !$('legalName')) return; tabs();
    $('legalName').textContent = `${item.name} · ${item.path}`; $('legalState').textContent = `已发布 v${item.published.version} · ${date(item.published.publishedAt)}${item.dirty ? ' · 当前页面有未保存编辑' : ' · 已同步'}`;
    $('legalBrowserTitle').value = item.draft.browserTitle || ''; $('legalDescription').value = item.draft.description || ''; $('legalEyebrow').value = item.draft.eyebrow || ''; $('legalTitle').value = item.draft.title || ''; $('legalSubtitle').value = item.draft.subtitle || ''; $('legalLastUpdated').value = item.published.document.lastUpdated || ''; $('legalContent').value = item.draft.content || ''; $('legalPreview').href = item.path; refreshLegalStyleEditors(item); history(item); renderDiff(item.published.document, item.draft);
    document.querySelectorAll('.legal-fields .cms-field-status').forEach((el) => { el.textContent = ''; });
  }
  async function load() {
    if (!$('legalTabs') || $('app')?.hidden) return;
    await legalToolbarReady;
    try { const data = await api('/admin/api/legal'); legalState.documents = data.documents || []; if (!legalState.documents.some((item) => item.key === legalState.active)) legalState.active = legalState.documents[0]?.key || 'privacy'; legalState.loaded = true; render(); }
    catch (error) { if (error.status !== 401) msg(error.message, 'bad'); }
  }
  async function saveLegalField(field, saveButton, statusNode) {
    const item = current(); if (!item) return; const pending = collect(); const original = saveButton.textContent; saveButton.disabled = true; saveButton.textContent = '保存中…'; statusNode.textContent = '正在发布';
    const next = { ...item.published.document, [field]: pending[field] }; if (styledFields.includes(field)) next.styles = { ...(item.published.document.styles || {}), [field]: pending.styles?.[field] || {} };
    try {
      const saved = await api(`/admin/api/legal/${item.key}/draft`, { method: 'PUT', body: JSON.stringify({ document: next }) });
      if (!saved.dirty) {
        replace(localMerge(saved, pending, field)); render(); statusNode.textContent = '无变化'; msg('该字段与当前已发布版本一致，无需重复发布。', 'good'); return;
      }
      let data;
      try { data = await api(`/admin/api/legal/${item.key}/publish`, { method: 'POST', body: JSON.stringify({ confirmation: `PUBLISH:${item.key}` }) }); }
      catch (error) {
        const restored = await api(`/admin/api/legal/${item.key}/restore`, { method: 'POST', body: '{}' }).catch(() => saved);
        replace(localMerge(restored, pending, null)); render(); throw error;
      }
      replace(localMerge(data, pending, field)); render(); statusNode.textContent = `已保存 · v${data.published.version}`; msg(`${data.name} 的“${field}”已保存并立即发布为 v${data.published.version}。`, 'good');
    } catch (error) { statusNode.textContent = '保存失败'; msg(error.message, 'bad'); }
    finally { saveButton.disabled = false; saveButton.textContent = original; }
  }
  async function installLegalFieldSaves() {
    richText = await cmsRichTextPromise;
    for (const [field, id] of Object.entries(fieldControls)) {
      const control = $(id); const label = control?.closest('label'); if (!control || !label || label.dataset.fieldSaveReady === '1') continue;
      label.dataset.fieldSaveReady = '1'; label.classList.add('cms-field'); const footer = node('span', 'cms-field-footer'); const status = node('small', 'cms-field-status'); const save = node('button', 'cms-field-save', '保存'); save.type = 'button'; save.addEventListener('click', () => void saveLegalField(field, save, status)); footer.append(status, save); label.append(footer);
    }
  }
  const legalToolbarReady = installLegalFieldSaves();
  const app = $('app'); if (app) new MutationObserver(() => { if (!app.hidden && !legalState.loaded) void load(); }).observe(app, { attributes: true, attributeFilter: ['hidden'] });
  if (app && !app.hidden) void load();
})();