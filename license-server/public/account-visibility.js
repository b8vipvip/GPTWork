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
    const response = await fetch(`/site/api/website?_=${Date.now()}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) return;
    const data = await response.json().catch(() => null);
    apply(data?.config);
  } catch {
    // Fail closed: commerce surfaces stay hidden until the website config can be read.
  }
}

void load();
