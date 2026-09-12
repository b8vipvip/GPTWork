import { readFile, writeFile, rm } from 'node:fs/promises';

async function read(path) { return readFile(path, 'utf8'); }
async function write(path, value) { await writeFile(path, value, 'utf8'); }

function replaceExact(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  return source.replace(from, to);
}

function replaceRegex(source, regex, to, label, expected = 1) {
  const matches = [...source.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`))];
  if (matches.length !== expected) throw new Error(`${label}: expected ${expected} matches, found ${matches.length}`);
  return source.replace(regex, to);
}

// background.js: consume the canonical per-tab authority directly. No legacy master writer,
// no legacy product-license protocol, and no policy monkeypatch layer.
{
  const path = 'extension/background.js';
  let source = await read(path);
  source = replaceExact(
    source,
    "import { createAccountClient } from './account-client.js';\n",
    "import { createAccountClient } from './account-client.js';\nimport {\n  effectivePolicyForTabSync,\n  lockConfigurationForTabSync,\n  tabFeatureEnabledSync,\n} from './tab-feature-runtime.js';\n",
    'background tab authority import',
  );
  source = replaceExact(
    source,
    "function effectiveSettingsForState(state) {\n  return { ...currentSettings, enabled: Boolean(currentSettings.enabled && accountAllowsState(state)) };\n}\nfunction guardFor(state) {\n  return evaluateGuard({\n    state,\n    policy: currentPolicy,\n    settings: effectiveSettingsForState(state),\n    inScope: isChatGptUrl(state.url),\n  });\n}\n",
    "function effectiveSettingsForState(state) {\n  return {\n    ...currentSettings,\n    enabled: Boolean(\n      currentSettings.enabled\n        && accountAllowsState(state)\n        && tabFeatureEnabledSync(state?.tabId),\n    ),\n  };\n}\nfunction guardFor(state) {\n  return evaluateGuard({\n    state,\n    policy: effectivePolicyForTabSync(state?.tabId),\n    settings: effectiveSettingsForState(state),\n    inScope: isChatGptUrl(state.url),\n  });\n}\n",
    'background effective settings',
  );
  source = replaceExact(
    source,
    "      policy: currentPolicy,\n      settings: effectiveSettingsForState(state),\n",
    "      policy: effectivePolicyForTabSync(tabId),\n      settings: effectiveSettingsForState(state),\n",
    'background tab broadcast policy',
  );
  source = replaceExact(
    source,
    "async function verifyObservation(observation) {\n  const result = await sendNative('verify', {\n    observation: {",
    "async function verifyObservation(observation, policy = currentPolicy) {\n  const result = await sendNative('verify', {\n    policy,\n    observation: {",
    'background verify policy override',
  );
  source = replaceExact(
    source,
    "    const result = await verifyObservation({\n      model: evidence.conflicts?.model ? null : evidence.model,",
    "    const result = await verifyObservation({\n      model: evidence.conflicts?.model ? null : evidence.model,",
    'background verify call anchor',
  );
  source = replaceExact(
    source,
    "      requestId: `cdp-${tabId}-${evidence.requestId}`,\n    });",
    "      requestId: `cdp-${tabId}-${evidence.requestId}`,\n    }, effectivePolicyForTabSync(tabId));",
    'background response verification tab policy',
  );
  source = replaceExact(
    source,
    "  getLockConfiguration() {\n    return {\n      lockedModels: currentPolicy.lockedModels,\n      allowedReasoningLevels: currentPolicy.allowedReasoningLevels,\n      preferredReasoning: currentSettings.preferredReasoning,\n      responseVerificationEnabled: currentSettings.networkVerificationEnabled,\n    };\n  },",
    "  getLockConfiguration(tabId) {\n    return lockConfigurationForTabSync(tabId, {\n      preferredReasoning: currentSettings.preferredReasoning,\n      responseVerificationEnabled: currentSettings.networkVerificationEnabled,\n    });\n  },",
    'background network lock configuration',
  );
  source = replaceExact(
    source,
    "async function configureTab(tab) {\n  if (!tab?.id || !isChatGptUrl(tab.url ?? '')) return;\n  const state = ensureTabState(tab.id, tab.url);\n  state.windowId = Number.isInteger(tab.windowId) ? tab.windowId : null;\n  if (effectiveSettingsForState(state).enabled) await networkMonitor.attach(tab.id);\n  else await networkMonitor.detach(tab.id);\n  await broadcastTabState(tab.id);\n  return state;\n}\n",
    "async function configureTab(tab) {\n  if (!tab?.id || !isChatGptUrl(tab.url ?? '')) return;\n  const state = ensureTabState(tab.id, tab.url);\n  state.windowId = Number.isInteger(tab.windowId) ? tab.windowId : null;\n  const enabled = effectiveSettingsForState(state).enabled;\n  if (!enabled || tab.status === 'loading') await networkMonitor.detach(tab.id);\n  else await networkMonitor.attach(tab.id);\n  await broadcastTabState(tab.id);\n  return state;\n}\n",
    'background direct debugger lifecycle',
  );
  source = replaceExact(
    source,
    "function requestLockConfirmed(state) {\n  return Boolean(\n    state.lastRequest?.model\n      && currentPolicy.lockedModels.includes(state.lastRequest.model),\n  );\n}\n\nfunction verificationOutcome(state, { timedOut = false } = {}) {\n  const verification = state.lastVerification;\n  const reasons = Array.isArray(verification?.reasons) ? verification.reasons : [];\n  const modelAllowed = Boolean(\n    verification?.model && currentPolicy.lockedModels.includes(verification.model),\n  );",
    "function requestLockConfirmed(state) {\n  const policy = effectivePolicyForTabSync(state?.tabId);\n  return Boolean(\n    state.lastRequest?.model\n      && policy.lockedModels.includes(state.lastRequest.model),\n  );\n}\n\nfunction verificationOutcome(state, { timedOut = false } = {}) {\n  const verification = state.lastVerification;\n  const reasons = Array.isArray(verification?.reasons) ? verification.reasons : [];\n  const policy = effectivePolicyForTabSync(state?.tabId);\n  const modelAllowed = Boolean(\n    verification?.model && policy.lockedModels.includes(verification.model),\n  );",
    'background auto verify tab policy',
  );
  source = replaceExact(
    source,
    "chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {\n  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;\n\n  const run = async () => {",
    "const TAB_FEATURE_MESSAGE_TYPES = new Set([\n  'GPTWORK_TAB_FEATURE_GET',\n  'GPTWORK_TAB_FEATURE_SET',\n  'GPTWORK_MASTER_STATUS',\n  'GPTWORK_MASTER_SET',\n]);\n\nchrome.runtime.onMessage.addListener((message, sender, sendResponse) => {\n  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;\n  if (TAB_FEATURE_MESSAGE_TYPES.has(message.type)) return false;\n\n  const run = async () => {",
    'background feature message ownership',
  );
  source = replaceExact(
    source,
    "          policy: currentPolicy,\n          settings: currentSettings,",
    "          policy: state ? effectivePolicyForTabSync(state.tabId) : currentPolicy,\n          settings: state ? effectiveSettingsForState(state) : currentSettings,",
    'background state snapshot tab policy',
  );
  source = replaceRegex(
    source,
    /      case 'GPTLOCK-LICENSE-GET':[\s\S]*?      case 'GPTLOCK_ACCOUNT_CONFIG':/,
    "      case 'GPTLOCK_ACCOUNT_CONFIG':",
    'remove legacy license protocol',
  );
  source = replaceRegex(
    source,
    /      case 'GPTLOCK_SET_ENABLED': \{[\s\S]*?\n      \}\n      case 'GPTLOCK_PAGE_OBSERVATION':/,
    "      case 'GPTLOCK_PAGE_OBSERVATION':",
    'remove legacy master writer',
  );
  source = replaceExact(
    source,
    "      case 'GPTLOCK_VERIFY':\n        return verifyObservation(message.observation ?? {});",
    "      case 'GPTLOCK_VERIFY': {\n        const policy = sender.tab?.id\n          ? effectivePolicyForTabSync(sender.tab.id)\n          : currentPolicy;\n        return verifyObservation(message.observation ?? {}, policy);\n      }",
    'background manual verify policy',
  );
  await write(path, source);
}

// network-monitor.js: ask for the tab policy explicitly instead of relying on prototype state.
{
  const path = 'extension/network-monitor.js';
  let source = await read(path);
  source = replaceExact(
    source,
    "  configuration() {\n    try {\n      return this.getLockConfiguration?.() ?? {};\n    } catch {\n      return {};\n    }\n  }",
    "  configuration(tabId) {\n    try {\n      return this.getLockConfiguration?.(tabId) ?? {};\n    } catch {\n      return {};\n    }\n  }",
    'network monitor tab configuration',
  );
  source = replaceRegex(source, /this\.configuration\(\)/g, 'this.configuration(tabId)', 'network configuration call sites', 2);
  await write(path, source);
}

// popup.js: master-ui-controller is the sole master UI writer. popup.js remains read-only for
// diagnostics/update rendering and must never persist or paint master state.
{
  const path = 'extension/popup.js';
  let source = await read(path);
  source = replaceExact(source, "  enabled: document.getElementById('enabled'),\n", '', 'popup enabled element owner');
  source = replaceExact(
    source,
    "  const enabled = state.settings?.enabled !== false;\n  elements.enabled.checked = enabled;\n",
    '',
    'popup master render writer',
  );
  source = replaceRegex(
    source,
    /\n\nelements\.enabled\.addEventListener\('change', \(\) => \{[\s\S]*?\n\}\);\n\n/,
    '\n\n',
    'popup legacy master change listener',
  );
  await write(path, source);
}

// tab-feature-runtime.js: register its own message types normally. Background explicitly opts
// out of them, so no event API monkeypatch is necessary.
{
  const path = 'extension/tab-feature-runtime.js';
  let source = await read(path);
  source = replaceRegex(
    source,
    /\/\/ Register the per-tab authority before background\.js,[\s\S]*?\nchrome\.tabs\.onRemoved\.addListener/,
    `chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {\n  if (!FEATURE_MESSAGE_TYPES.has(message?.type)) return false;\n  handleFeatureMessage(message, sender).then(\n    (data) => sendResponse({ ok: true, data }),\n    (error) => sendResponse({\n      ok: false,\n      error: error instanceof Error ? error.message : String(error),\n      code: error?.code || null,\n    }),\n  );\n  return true;\n});\n\nchrome.tabs.onRemoved.addListener`,
    'tab feature message monkeypatch removal',
  );
  await write(path, source);
}

// master-ui-controller.js: no competing change listener remains, so event suppression is no
// longer part of correctness.
{
  const path = 'extension/master-ui-controller.js';
  let source = await read(path);
  source = replaceExact(source, "      event.stopImmediatePropagation();\n", '', 'master event suppression');
  source = replaceExact(source, "    masterToggle.addEventListener('change', (event) => {\n", "    masterToggle.addEventListener('change', () => {\n", 'master event parameter');
  await write(path, source);
}

// background-entry.js: remove policy/safety monkeypatch modules; the direct runtime now owns
// both debugger lifecycle and per-tab request/verification policy.
{
  const path = 'extension/background-entry.js';
  let source = await read(path);
  source = source.replace("import './tab-feature-network-policy.js';\n", '');
  source = source.replace("import './network-monitor-safety.js';\n", '');
  source = source.replace(/\/\/ Make both request rewriting[\s\S]*?tab-specific effective policy\.\n/, '');
  source = source.replace(/\/\/ Patch ChatGptNetworkMonitor[\s\S]*?feature state is enabled\.\n/, '');
  await write(path, source);
}

// package.json: deleted monkeypatch modules are no longer syntax-checked.
{
  const path = 'extension/package.json';
  let source = await read(path);
  source = source.replace(' && node --check tab-feature-network-policy.js', '');
  source = source.replace(' && node --check network-monitor-safety.js', '');
  await write(path, source);
}

await rm('extension/tab-feature-network-policy.js');
await rm('extension/network-monitor-safety.js');

// Final static invariants for this one-shot refactor.
const production = [
  'extension/background.js',
  'extension/popup.js',
  'extension/tab-feature-runtime.js',
  'extension/master-ui-controller.js',
].map(async (path) => [path, await read(path)]);
for (const [path, source] of await Promise.all(production)) {
  if (/GPTLOCK-LICENSE|GPTLOCK_LICENSE|LICENSE_UI_STALE|GPTLOCK_SET_ENABLED/.test(source)) {
    throw new Error(`${path}: legacy product-license/master protocol remains`);
  }
  if (/chrome\.runtime\.sendMessage\s*=|chrome\.runtime\.onMessage\.addListener\s*=|ChatGptNetworkMonitor\.prototype/.test(source)) {
    throw new Error(`${path}: runtime monkeypatch remains`);
  }
}
