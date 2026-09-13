export const CURRENT_SETTINGS_PAGE = 'settings-v0521.html';
export const LEGACY_SETTINGS_PAGES = new Set([
  'options.html',
  'settings-v0517.html',
  'settings-v0519.html',
]);

const DISCOVERED_MODELS_KEY = 'discoveredModels';
const DISCOVERED_MODEL_EVIDENCE_KEY = 'discoveredModelEvidence';
const POLICY_KEY = 'policy';
const ASTRA_POLICY_MIGRATION_KEY = 'astraPolicyMigrationV1';
const ASTRA_MODEL_ID = 'gpt-6-astra';
const SOL_MODEL_ID = 'gpt-5.6-sol';
const NON_CONCRETE_MODEL_IDS = new Set(['auto']);

function extensionPageName(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'chrome-extension:' || parsed.hostname !== chrome.runtime.id) return null;
    return parsed.pathname.split('/').filter(Boolean).pop() || null;
  } catch {
    return null;
  }
}

function replacementUrl(url) {
  let hash = '';
  try { hash = new URL(url).hash || ''; } catch {}
  return chrome.runtime.getURL(`${CURRENT_SETTINGS_PAGE}${hash}`);
}

function isNonConcreteModelId(value) {
  const model = String(value ?? '').trim().toLowerCase();
  return NON_CONCRETE_MODEL_IDS.has(model);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function purgeNonConcreteModelState() {
  const stored = await chrome.storage.sync.get([
    DISCOVERED_MODELS_KEY,
    DISCOVERED_MODEL_EVIDENCE_KEY,
    POLICY_KEY,
    ASTRA_POLICY_MIGRATION_KEY,
  ]);
  const patch = {};

  if (Array.isArray(stored[DISCOVERED_MODELS_KEY])) {
    const discovered = stored[DISCOVERED_MODELS_KEY].filter((model) => !isNonConcreteModelId(model));
    if (!sameJson(discovered, stored[DISCOVERED_MODELS_KEY])) {
      patch[DISCOVERED_MODELS_KEY] = discovered;
    }
  }

  const evidence = stored[DISCOVERED_MODEL_EVIDENCE_KEY];
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const filteredEvidence = Object.fromEntries(
      Object.entries(evidence).filter(([model]) => !isNonConcreteModelId(model)),
    );
    if (!sameJson(filteredEvidence, evidence)) {
      patch[DISCOVERED_MODEL_EVIDENCE_KEY] = filteredEvidence;
    }
  }

  const policy = stored[POLICY_KEY];
  if (policy && typeof policy === 'object' && Array.isArray(policy.lockedModels)) {
    let lockedModels = policy.lockedModels.filter((model) => !isNonConcreteModelId(model));
    if (!sameJson(lockedModels, policy.lockedModels)) {
      patch[POLICY_KEY] = { ...policy, lockedModels };
    }
    if (!stored[ASTRA_POLICY_MIGRATION_KEY]
      && lockedModels.includes(SOL_MODEL_ID)
      && !lockedModels.includes(ASTRA_MODEL_ID)) {
      lockedModels = [ASTRA_MODEL_ID, ...lockedModels];
      patch[POLICY_KEY] = { ...policy, lockedModels };
    }
  }

  if (!stored[ASTRA_POLICY_MIGRATION_KEY]) {
    patch[ASTRA_POLICY_MIGRATION_KEY] = true;
  }

  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
  return patch;
}

export async function redirectLegacySettingsTab(tab) {
  if (!Number.isInteger(tab?.id) || !LEGACY_SETTINGS_PAGES.has(extensionPageName(tab.url))) return false;
  await chrome.tabs.update(tab.id, { url: replacementUrl(tab.url) });
  return true;
}

export async function redirectLegacySettingsTabs() {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((tab) => LEGACY_SETTINGS_PAGES.has(extensionPageName(tab.url)));
  await Promise.all(candidates.map((tab) => redirectLegacySettingsTab(tab).catch(() => false)));
  return candidates.length;
}

function runMigration() {
  void redirectLegacySettingsTabs().catch(() => {});
  void purgeNonConcreteModelState().catch(() => {});
}

// A runtime reload after an in-place update can leave an already-open extension page
// rendered with its old DOM. Run immediately when the new service worker starts, and
// again on install/startup, so stale settings tabs are navigated to the current
// cache-busted settings document without requiring the user to close them. Model state
// cleanup runs at the same lifecycle points so a historical `auto` router alias cannot
// remain lockable merely because the user has not opened Settings after upgrading.
// The Astra preference is folded into the same atomic storage patch: existing policies
// that already allow Sol gain Astra once, but a later manual Astra opt-out is respected.
runMigration();
chrome.runtime.onInstalled.addListener(runMigration);
chrome.runtime.onStartup.addListener(runMigration);
