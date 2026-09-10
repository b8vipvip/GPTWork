import { createLegalContentSystem } from './legal-content-system.mjs';
import { normalizeTextStyles } from './text-style.mjs';

const WEBSITE_SETTING_KEY = 'website_config_v1';

const PAGE_DEFAULTS = {
  guide: {
    name: '使用教程', browserTitle: '使用教程 · GPTWork', description: 'GPTWork 使用教程：安装、登录、模型偏好、验证与日常维护。',
    hero: { eyebrow: '从安装到日常使用', title: '按步骤设置一次，\n之后正常聊天。', body: '这份教程只保留用户需要操作的内容。安装、登录、选择偏好并开启 GPTWork 后，就可以像平时一样使用 ChatGPT。' },
    modules: [
      { id: 'guide-steps', type: 'guide-steps', name: '教程步骤', enabled: true, order: 10, items: [
        { title: '安装 GPTWork', body: 'Windows 使用正式发布的 GPTWorkSetup-x64.exe；Linux 使用对应的 deb。安装完成后按安装提示启用浏览器扩展，并完全重启浏览器。' },
        { title: '检查安装状态', body: '打开 GPTWork。状态显示正常即可继续；如果提示组件离线或安装异常，先使用修复功能或重新安装，不需要手动判断内部原因。' },
        { title: '登录 GPTWork 账户', body: '使用 GPTWork 账户登录。账户中心可以查看当前权益、管理已绑定设备、退出旧会话和修改密码。' },
        { title: '选择模型与推理偏好', body: '在设置中选择首选模型和需要的推理强度。建议只选择你实际会使用的配置，日常会更清楚。' },
        { title: '开启 GPTWork', body: '确认状态正常后开启 GPTWork，然后回到 chatgpt.com 正常输入并发送消息。无需在每轮聊天前重复设置。' },
        { title: '遇到异常时再诊断', body: '如果页面状态、模型表现或插件状态与预期不一致，可以使用自动验证和运行日志。诊断结果可用于排查问题，不需要用户理解底层实现。' },
        { title: '保持更新', body: '建议优先使用正式发布版本。版本发布页只展示 Windows、Linux 等用户实际需要的安装包；安装包已经包含对应版本的扩展文件。' },
      ] },
      { id: 'guide-callout', type: 'callout', name: '底部引导', enabled: true, order: 20, title: '需要知道的只有怎么用。', body: 'GPTWork 的内部实现、判断细节和安全策略不会在公开教程中展开。用户只需要关注当前状态、自己的配置以及是否正常工作。', buttonLabel: '下载正式版本', buttonHref: '/releases' },
    ],
  },
  releases: {
    name: '版本发布', browserTitle: '版本发布 · GPTWork', description: 'GPTWork 正式版本、发布时间与安装文件。',
    hero: { eyebrow: 'Official releases', title: '下载正式版本，\n保持稳定更新。', body: '这里提供 GPTWork 的正式版本号、发布时间和安装文件。公开站点只展示用户需要的版本信息，不展开内部实现与技术改动细节。' },
    modules: [{ id: 'release-feed', type: 'protected', name: '正式版本列表', enabled: true, order: 10 }],
  },
  issues: {
    name: 'Issues 讨论区', browserTitle: 'Issues 讨论区 · GPTWork', description: 'GPTWork Issues 讨论区 — 提问、Bug 跟踪、功能建议与用户互助。',
    hero: { eyebrow: 'GPTWork Community', title: 'Issues 讨论区\nQuestions · Bugs · Ideas', body: '轻量的问题跟踪与用户互助区。所有人都可以浏览；登录 GPTWork 账户后可以新建问题和参与解答。请不要提交密码、Cookie、Token、支付信息、私人聊天或未经脱敏的完整诊断日志。' },
    modules: [
      { id: 'issues-search', type: 'protected', name: 'Issues 搜索', enabled: true, order: 10 },
      { id: 'issues-new', type: 'protected', name: '新建 Issue', enabled: true, order: 20 },
      { id: 'issues-detail', type: 'protected', name: 'Issue 详情与回复', enabled: true, order: 30 },
      { id: 'issues-list', type: 'protected', name: 'Issues 列表', enabled: true, order: 40 },
    ],
  },
  support: {
    name: '支持中心', browserTitle: '支持中心 · Support · GPTWork', description: 'GPTWork Support Center / 支持中心',
    hero: { eyebrow: 'Support Center', title: '支持中心\nSupport', body: '先从本地状态、账户状态和诊断日志判断问题，再提交最小必要信息。这样既能提高定位效率，也能避免把私人聊天或账户凭据公开出去。' },
    modules: [
      { id: 'support-links', type: 'protected', name: '支持入口卡片', enabled: true, order: 10, lockedOrder: true },
      { id: 'support-warning', type: 'protected', name: '敏感数据警告', enabled: true, order: 20, lockedOrder: true },
    ],
  },
  account: {
    name: '账户中心', browserTitle: '账户中心 · GPTWork', description: 'GPTWork 账户、权益、设备、会话、支付与安全管理。',
    hero: { eyebrow: 'Account & security', title: '账户不是一张表，\n而是你的使用边界。', body: '查看权益、已绑定设备、插件会话和网页登录；需要时释放旧设备、注销会话、修改密码或永久删除账户与关联数据。' },
    modules: [
      { id: 'account-login', type: 'protected', name: '账户登录', enabled: true, order: 10 },
      { id: 'account-dashboard', type: 'protected', name: '账户权益与安全面板', enabled: true, order: 20 },
      { id: 'account-membership-plans', type: 'protected', name: '会员方案', enabled: false, order: 30, lockedOrder: true },
      { id: 'account-recent-orders', type: 'protected', name: '最近订单', enabled: false, order: 40, lockedOrder: true },
    ],
  },
};

export const DEFAULT_WEBSITE_CONFIG = {
  schemaVersion: 3,
  site: {
    brandName: 'GPTWork',
    title: 'GPTWork · Work 模式与模型锁定',
    description: 'GPTWork — 面向 ChatGPT 官方网页聊天的 Work 模式与模型锁定辅助工具。',
    footerText: 'GPTWork · Work mode & model lock',
  },
  navigation: [
    { id: 'product', label: '产品', href: '/', enabled: true, order: 10 },
    { id: 'guide', label: '使用教程', href: '/guide', enabled: true, order: 20 },
    { id: 'releases', label: '版本发布', href: '/releases', enabled: true, order: 30 },
    { id: 'issues', label: 'Issues', href: '/issues', enabled: true, order: 40 },
    { id: 'support', label: '支持', href: '/support', enabled: true, order: 50 },
    { id: 'privacy', label: '隐私', href: '/privacy', enabled: true, order: 60 },
    { id: 'account', label: '账户中心', href: '/account', enabled: true, order: 70, account: true },
  ],
  homeModules: [
    {
      id: 'hero', type: 'hero', name: '首页主视觉', enabled: true, order: 10,
      badge: 'Windows / Linux · Chrome / Edge', title: 'GPTWork\n能做什么？',
      body: '1. GPTWork 会员侧不限次数使用 ChatGPT Work 模式。\n2. 避免模型意外降级，自动锁定 GPT-5.6 模型或已支持的更高模型。\n\nGPTWork 负责模型偏好锁定、状态验证与异常提示；ChatGPT 实际可用模型、Work 模式、额度和服务能力仍以对应 ChatGPT 账户及平台策略为准。',
      primaryLabel: '开始使用', primaryHref: '/guide', secondaryLabel: '下载最新版本', secondaryHref: '/releases', tertiaryLabel: '登录账户', tertiaryHref: '/account',
      statusLabel: '● GPTWork 已开启', modeLabel: 'Work 模式', modeValue: '已启用', stateLabel: '状态', stateValue: '正常', modelLabel: '锁定模型', modelValue: 'GPT-5.6 Sol', reasoningLabel: '推理偏好', reasoningValue: 'High', protectionLabel: '异常保护', protectionValue: '自动验证与提示', noteText: '锁定模型\n减少意外降级', signalTitle: 'Work 模式', signalText: 'GPTWork 会员侧不另设使用次数上限。',
    },
    { id: 'features', type: 'features', name: '核心功能', enabled: true, order: 20, title: '围绕两件事：\nWork 模式与模型锁定。', lead: '把常用设置固定下来，并持续确认实际状态；出现不符合锁定策略的情况时给出明确提示。', items: [
      { title: 'Work 模式持续使用', body: 'GPTWork 会员侧不额外限制使用次数，日常直接进入 Work 工作流；第三方平台自身额度与可用性仍由对应账户决定。' },
      { title: '自动锁定首选模型', body: '锁定 GPT-5.6 或 GPTWork 已支持的更高模型，减少模型偏好被意外切换或降级时不易察觉的问题。' },
      { title: '状态验证与异常提示', body: '结合自动验证、状态提示和诊断入口，让模型状态、账户状态和需要处理的问题更容易确认。' },
    ] },
    { id: 'workflow', type: 'workflow', name: '使用流程', enabled: true, order: 30, title: '从安装到日常使用，\n只保留必要步骤。', lead: '安装完成后，登录账户、选择偏好并开启 GPTWork。之后正常使用 ChatGPT；只有遇到异常时才需要诊断或更新。', items: [
      { title: '① 安装', body: '安装正式版本并启用扩展' }, { title: '② 登录', body: '使用 GPTWork 账户' }, { title: '③ 设置', body: '选择 Work 模式、模型与推理偏好' }, { title: '④ 开启', body: '确认锁定与验证状态正常' }, { title: '⑤ 聊天', body: '像平时一样使用 ChatGPT' }, { title: '⑥ 维护', body: '需要时诊断、更新或管理账户' },
    ], primaryLabel: '查看使用教程', primaryHref: '/guide', secondaryLabel: '进入 Issues 讨论区', secondaryHref: '/issues' },
    { id: 'callout', type: 'callout', name: '底部引导', enabled: true, order: 40, title: '下载、教程、账户、Issues，一个网站就够。', body: '正式版本、使用教程、账户管理和公开问题讨论都集中在 GPTWork 官网。', buttonLabel: '打开 Issues', buttonHref: '/issues' },
  ],
  pages: PAGE_DEFAULTS,
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value, fallback = '', max = 4000) { return String(value ?? fallback).replace(/\r\n?/g, '\n').trim().slice(0, max); }
function bool(value, fallback = true) { return typeof value === 'boolean' ? value : fallback; }
function numericOrder(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(-9999, Math.min(9999, Math.round(parsed))) : fallback; }
function safeHref(value, fallback = '/') { const href = text(value, fallback, 500); if (/^\/(?!\/)[^\s]*$/.test(href)) return href; try { const url = new URL(href); if (url.protocol === 'https:') return url.toString(); } catch {} return fallback; }
function slug(value, fallback) { const result = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48); return result || fallback; }
function normalizeItems(value, defaults, maxItems = 8) { const source = Array.isArray(value) ? value : defaults; return source.slice(0, maxItems).map((item, index) => ({ title: text(item?.title, defaults[index]?.title || `项目 ${index + 1}`, 160), body: text(item?.body, defaults[index]?.body || '', 1200), styles: normalizeTextStyles(item?.styles, ['title','body']) })); }

function normalizeHomeModule(raw, fallback, index) {
  const type = ['hero', 'features', 'workflow', 'callout', 'custom'].includes(raw?.type) ? raw.type : fallback?.type || 'custom';
  const base = fallback || { id: `custom-${index + 1}`, type: 'custom', name: '自定义内容', enabled: true, order: (index + 1) * 10, title: '自定义模块', body: '', buttonLabel: '', buttonHref: '/' };
  const common = { id: slug(raw?.id, base.id), type, name: text(raw?.name, base.name, 80), enabled: bool(raw?.enabled, base.enabled), order: numericOrder(raw?.order, base.order) };
  if (type === 'hero') return { ...common, badge: text(raw?.badge, base.badge, 160), title: text(raw?.title, base.title, 300), body: text(raw?.body, base.body, 5000), primaryLabel: text(raw?.primaryLabel, base.primaryLabel, 80), primaryHref: safeHref(raw?.primaryHref, base.primaryHref), secondaryLabel: text(raw?.secondaryLabel, base.secondaryLabel, 80), secondaryHref: safeHref(raw?.secondaryHref, base.secondaryHref), tertiaryLabel: text(raw?.tertiaryLabel, base.tertiaryLabel, 80), tertiaryHref: safeHref(raw?.tertiaryHref, base.tertiaryHref), statusLabel: text(raw?.statusLabel, base.statusLabel, 100), modeLabel: text(raw?.modeLabel, base.modeLabel, 80), modeValue: text(raw?.modeValue, base.modeValue, 100), stateLabel: text(raw?.stateLabel, base.stateLabel, 80), stateValue: text(raw?.stateValue, base.stateValue, 100), modelLabel: text(raw?.modelLabel, base.modelLabel, 80), modelValue: text(raw?.modelValue, base.modelValue, 100), reasoningLabel: text(raw?.reasoningLabel, base.reasoningLabel, 80), reasoningValue: text(raw?.reasoningValue, base.reasoningValue, 100), protectionLabel: text(raw?.protectionLabel, base.protectionLabel, 80), protectionValue: text(raw?.protectionValue, base.protectionValue, 140), noteText: text(raw?.noteText, base.noteText, 200), signalTitle: text(raw?.signalTitle, base.signalTitle, 100), signalText: text(raw?.signalText, base.signalText, 300), styles: normalizeTextStyles(raw?.styles, ['badge','title','body','primaryLabel','secondaryLabel','tertiaryLabel','statusLabel','modeLabel','modeValue','stateLabel','stateValue','modelLabel','modelValue','reasoningLabel','reasoningValue','protectionLabel','protectionValue','noteText','signalTitle','signalText']) };
  if (type === 'features') return { ...common, title: text(raw?.title, base.title, 300), lead: text(raw?.lead, base.lead, 1200), items: normalizeItems(raw?.items, base.items, 6), styles: normalizeTextStyles(raw?.styles, ['title','lead']) };
  if (type === 'workflow') return { ...common, title: text(raw?.title, base.title, 300), lead: text(raw?.lead, base.lead, 1200), items: normalizeItems(raw?.items, base.items, 8), primaryLabel: text(raw?.primaryLabel, base.primaryLabel, 80), primaryHref: safeHref(raw?.primaryHref, base.primaryHref), secondaryLabel: text(raw?.secondaryLabel, base.secondaryLabel, 80), secondaryHref: safeHref(raw?.secondaryHref, base.secondaryHref), styles: normalizeTextStyles(raw?.styles, ['title','lead','primaryLabel','secondaryLabel']) };
  if (type === 'callout') return { ...common, title: text(raw?.title, base.title, 300), body: text(raw?.body, base.body, 1200), buttonLabel: text(raw?.buttonLabel, base.buttonLabel, 80), buttonHref: safeHref(raw?.buttonHref, base.buttonHref), styles: normalizeTextStyles(raw?.styles, ['title','body','buttonLabel']) };
  return { ...common, type: 'custom', title: text(raw?.title, base.title, 300), body: text(raw?.body, base.body, 5000), buttonLabel: text(raw?.buttonLabel, base.buttonLabel, 80), buttonHref: safeHref(raw?.buttonHref, base.buttonHref), styles: normalizeTextStyles(raw?.styles, ['title','body','buttonLabel']) };
}

function normalizePageModule(raw, fallback) {
  const base = fallback;
  const common = { id: base.id, type: base.type, name: base.name, enabled: bool(raw?.enabled, base.enabled), order: numericOrder(raw?.order, base.order), lockedOrder: Boolean(base.lockedOrder) };
  if (base.type === 'guide-steps') return { ...common, items: normalizeItems(raw?.items, base.items, 7) };
  if (base.type === 'callout') return { ...common, title: text(raw?.title, base.title, 300), body: text(raw?.body, base.body, 1600), buttonLabel: text(raw?.buttonLabel, base.buttonLabel, 80), buttonHref: safeHref(raw?.buttonHref, base.buttonHref), styles: normalizeTextStyles(raw?.styles, ['title','body','buttonLabel']) };
  return common;
}

function normalizePage(raw, defaults) {
  const hero = raw?.hero || {};
  const rawModules = Array.isArray(raw?.modules) ? raw.modules : [];
  return {
    name: defaults.name,
    browserTitle: text(raw?.browserTitle, defaults.browserTitle, 160),
    description: text(raw?.description, defaults.description, 500),
    hero: { eyebrow: text(hero.eyebrow, defaults.hero.eyebrow, 160), title: text(hero.title, defaults.hero.title, 300), body: text(hero.body, defaults.hero.body, 2000), styles: normalizeTextStyles(hero.styles, ['eyebrow','title','body']) },
    modules: defaults.modules.map((base) => normalizePageModule(rawModules.find((item) => item?.id === base.id), base)),
  };
}

export function normalizeWebsiteConfig(input = {}) {
  const defaults = DEFAULT_WEBSITE_CONFIG; const site = input.site || {};
  const configuredNavigation = Array.isArray(input.navigation) ? input.navigation : defaults.navigation;
  const navigation = configuredNavigation.slice(0, 16).map((item, index) => { const fallback = defaults.navigation.find((candidate) => candidate.id === item?.id) || defaults.navigation[index] || { id: `nav-${index + 1}`, label: '链接', href: '/', enabled: true, order: (index + 1) * 10 }; return { id: slug(item?.id, fallback.id), label: text(item?.label, fallback.label, 80), href: safeHref(item?.href, fallback.href), enabled: bool(item?.enabled, fallback.enabled), order: numericOrder(item?.order, fallback.order), account: bool(item?.account, fallback.account || false), styles: normalizeTextStyles(item?.styles, ['label']) }; });
  const sourceModules = Array.isArray(input.homeModules) ? input.homeModules : defaults.homeModules; const modules = []; const seen = new Set();
  for (let index = 0; index < Math.min(sourceModules.length, 20); index += 1) { const raw = sourceModules[index] || {}; const fallback = defaults.homeModules.find((module) => module.id === raw.id) || (!raw.type || raw.type !== 'custom' ? defaults.homeModules[index] : null); const normalized = normalizeHomeModule(raw, fallback, index); if (seen.has(normalized.id)) normalized.id = `custom-${index + 1}`; seen.add(normalized.id); modules.push(normalized); }
  for (const defaultModule of defaults.homeModules) if (!seen.has(defaultModule.id)) modules.push(clone(defaultModule));
  const pages = {}; for (const [key, pageDefaults] of Object.entries(PAGE_DEFAULTS)) pages[key] = normalizePage(input.pages?.[key], pageDefaults);
  return { schemaVersion: 3, site: { brandName: text(site.brandName, defaults.site.brandName, 80), title: text(site.title, defaults.site.title, 160), description: text(site.description, defaults.site.description, 500), footerText: text(site.footerText, defaults.site.footerText, 160), styles: normalizeTextStyles(site.styles, ['brandName','footerText']) }, navigation, homeModules: modules, pages };
}

export function createWebsiteSystem({ db, json }) {
  const getSetting = db.prepare('SELECT value, updated_at FROM app_settings WHERE key = ?');
  const setSetting = db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
  const audit = db.prepare('INSERT INTO audit_log(event,detail,created_at) VALUES(?,?,?)');
  const legalSystem = createLegalContentSystem({ db, json });
  function read() { const row = getSetting.get(WEBSITE_SETTING_KEY); if (!row) return { config: clone(DEFAULT_WEBSITE_CONFIG), updatedAt: null }; try { return { config: normalizeWebsiteConfig(JSON.parse(row.value)), updatedAt: row.updated_at || null }; } catch { return { config: clone(DEFAULT_WEBSITE_CONFIG), updatedAt: row.updated_at || null }; } }
  function save(config, event = 'website_config_updated') { const normalized = normalizeWebsiteConfig(config); const updatedAt = new Date().toISOString(); setSetting.run(WEBSITE_SETTING_KEY, JSON.stringify(normalized), updatedAt); audit.run(event, JSON.stringify({ modules: normalized.homeModules.length, navigation: normalized.navigation.length, pages: Object.keys(normalized.pages).length }), updatedAt); return { config: normalized, updatedAt }; }
  if (!getSetting.get(WEBSITE_SETTING_KEY)) save(DEFAULT_WEBSITE_CONFIG, 'website_config_initialized');
  async function handleSite(req, res, url) {
    if (url.pathname === '/site/api/website' && req.method === 'GET') { const data = read(); json(res, 200, { ok: true, ...data }); return true; }
    return legalSystem.handleSite(req, res, url);
  }
  async function handleAdmin(req, res, url, bodyJson) {
    if (url.pathname === '/admin/api/website' && req.method === 'GET') { json(res, 200, { ok: true, ...read(), defaults: clone(DEFAULT_WEBSITE_CONFIG), legal: legalSystem.readAllAdmin() }); return true; }
    if (url.pathname === '/admin/api/website' && req.method === 'PUT') { const input = await bodyJson(req); const data = save(input.config || input); json(res, 200, { ok: true, ...data }); return true; }
    if (url.pathname === '/admin/api/website/reset' && req.method === 'POST') { const data = save(DEFAULT_WEBSITE_CONFIG, 'website_config_reset'); json(res, 200, { ok: true, ...data }); return true; }
    return legalSystem.handleAdmin(req, res, url, bodyJson);
  }
  return { read, handleSite, handleAdmin, legalSystem };
}