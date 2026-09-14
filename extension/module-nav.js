const MODULES = [
  { id: 'account', href: 'account.html', label: '账户中心', english: 'Account' },
  { id: 'settings', href: 'settings-v0521.html', label: '设置', english: 'Settings' },
  { id: 'help', href: 'help.html', label: '使用帮助', english: 'Help' },
  { id: 'update', href: 'update.html', label: '版本更新', english: 'Update' },
  { id: 'diagnostics', href: 'diagnostics.html', label: '诊断日志', english: 'Diagnostics' },
];

function buildModuleLink(module, current) {
  const link = document.createElement('a');
  link.href = module.href;
  link.dataset.module = module.id;
  if (module.id === current) link.setAttribute('aria-current', 'page');

  const label = document.createElement('span');
  label.textContent = module.label;
  const english = document.createElement('small');
  english.textContent = module.english;
  link.append(label, english);
  return link;
}

function mountModuleNavigation() {
  const main = document.querySelector('main');
  if (!main || main.querySelector('.gptwork-module-nav')) return;

  const nav = document.createElement('nav');
  nav.className = 'gptwork-module-nav';
  nav.setAttribute('aria-label', 'GPTWork 模块导航 / Module navigation');
  const current = document.body.dataset.gptworkModule || '';
  for (const module of MODULES) nav.append(buildModuleLink(module, current));
  main.prepend(nav);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountModuleNavigation, { once: true });
} else {
  mountModuleNavigation();
}
