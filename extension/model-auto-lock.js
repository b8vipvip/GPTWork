(() => {
  const DISCOVERED_MODELS_KEY = 'discoveredModels';
  const POLICY_KEY = 'policy';
  const MODEL_SELECTION_KEY = 'gptworkModelLockSelection';
  const WORK_MODE_KEY = 'gptworkWorkModeEnabled';
  const MODEL_LOCK_KEY = 'gptworkModelLockEnabled';
  const ASTRA_MODEL_ID = 'gpt-6-astra';
  const SOL_MODEL_ID = 'gpt-5.6-sol';
  const MODEL_ALIASES = Object.freeze({
    'gpt-5.6-sol-wm': SOL_MODEL_ID,
    'gpt-5-6': SOL_MODEL_ID,
  });
  const NON_CONCRETE_MODEL_IDS = new Set(['auto']);
  let writeQueue = Promise.resolve();

  function normalizeModelId(value) {
    const model = String(value ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._:-]{1,128}$/.test(model)) return null;
    if (model === ASTRA_MODEL_ID || /^(?:gpt-6-astra)(?:[-_.:][a-z0-9._:-]+)$/.test(model)) {
      return ASTRA_MODEL_ID;
    }
    return MODEL_ALIASES[model] ?? model;
  }

  function normalizeConcreteModelId(value) {
    const model = normalizeModelId(value);
    return model && !NON_CONCRETE_MODEL_IDS.has(model) ? model : null;
  }

  function normalizeModels(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map(normalizeConcreteModelId)
      .filter(Boolean))];
  }

  function newlyDiscovered(change) {
    const previous = new Set(normalizeModels(change?.oldValue));
    return normalizeModels(change?.newValue).filter((model) => !previous.has(model));
  }

  function isAtLeastSol(model) {
    const normalized = normalizeConcreteModelId(model);
    if (!normalized) return false;
    if (normalized === ASTRA_MODEL_ID || normalized === SOL_MODEL_ID) return true;
    const match = normalized.match(/^gpt-(\d+)(?:[.-](\d+))?/i);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2] || 0);
    return major > 5 || (major === 5 && minor >= 6);
  }

  function defaultPolicy() {
    return {
      lockedModels: [ASTRA_MODEL_ID, SOL_MODEL_ID],
      allowedReasoningLevels: ['medium', 'high', 'extra-high'],
      strictMode: true,
    };
  }

  function mergeWorkModels(discovered) {
    return [...new Set([ASTRA_MODEL_ID, SOL_MODEL_ID, ...normalizeModels(discovered).filter(isAtLeastSol)])];
  }

  function refreshActivePolicy(models) {
    if (!models.length) return;
    writeQueue = writeQueue.then(async () => {
      const [local, stored] = await Promise.all([
        chrome.storage.local.get([WORK_MODE_KEY, MODEL_LOCK_KEY]),
        chrome.storage.sync.get([POLICY_KEY, MODEL_SELECTION_KEY, DISCOVERED_MODELS_KEY]),
      ]);
      const workModeEnabled = local[WORK_MODE_KEY] === true;
      const modelLockEnabled = local[MODEL_LOCK_KEY] === true;

      // Discovery never edits the user's explicit Model-lock selection. New GPT-5.6+
      // models are inherited automatically only by Work mode, matching its contract.
      if (!workModeEnabled) return;

      const policy = stored[POLICY_KEY] && typeof stored[POLICY_KEY] === 'object'
        ? stored[POLICY_KEY]
        : defaultPolicy();
      const savedSelection = normalizeModels(stored[MODEL_SELECTION_KEY]);
      const selection = savedSelection.length ? savedSelection : normalizeModels(policy.lockedModels);

      const active = [...mergeWorkModels(stored[DISCOVERED_MODELS_KEY])];
      if (modelLockEnabled) active.push(...selection);
      const lockedModels = [...new Set(active)];
      if (!lockedModels.length) return;

      if (JSON.stringify(normalizeModels(policy.lockedModels)) !== JSON.stringify(lockedModels)) {
        await chrome.storage.sync.set({ [POLICY_KEY]: { ...policy, lockedModels } });
      }
    }).catch(() => {});
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes[DISCOVERED_MODELS_KEY]) return;
    refreshActivePolicy(newlyDiscovered(changes[DISCOVERED_MODELS_KEY]));
  });
})();
