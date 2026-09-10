const WEBSITE_CONFIG_URL = 'https://gptlock.mv3.cn/site/api/website';
const SURFACES = [
  ['account-membership-plans', 'membershipPlansSection'],
  ['account-recent-orders', 'recentOrdersSection'],
];

function setVisible(element, visible) {
  if (!element) return;
  element.hidden = !visible;
  element.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function apply(config) {
  const modules = Array.isArray(config?.pages?.account?.modules) ? config.pages.account.modules : [];
  for (const [moduleId, elementId] of SURFACES) {
    const module = modules.find((item) => item?.id === moduleId);
    setVisible(document.getElementById(elementId), Boolean(module?.enabled));
  }
}

async function load() {
  try {
    const response = await fetch(`${WEBSITE_CONFIG_URL}?_=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) return;
    const data = await response.json().catch(() => null);
    apply(data?.config);
  } catch {
    // Fail closed: hidden-by-default commerce surfaces remain hidden.
  }
}

void load();
