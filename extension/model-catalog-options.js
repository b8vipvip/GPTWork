(() => {
  const STORAGE_KEY = 'discoveredModels';
  const EVIDENCE_STORAGE_KEY = 'discoveredModelEvidence';
  const DISCOVERY_SCHEMA_KEY = 'modelDiscoverySchemaVersion';
  const DISCOVERY_SCHEMA_VERSION = 3;
  const MODEL_ALIASES = Object.freeze({
    'gpt-5.6-sol-wm': 'gpt-5.6-sol',
    'gpt-5-6': 'gpt-5.6-sol',
  });
  const NON_CONCRETE_MODEL_IDS = new Set(['auto']);

  function normalizeModelId(value) {
    const model = String(value ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._:-]{1,128}$/.test(model)) return null;
    return MODEL_ALIASES[model] ?? model;
  }

  function normalizeConcreteModelId(value) {
    const model = normalizeModelId(value);
    return model && !NON_CONCRETE_MODEL_IDS.has(model) ? model : null;
  }

  function legacySuspiciousModel(value) {
    const model = normalizeConcreteModelId(value);
    if (!model) return true;
    if (/^gpt-5\.6-(?:s|so)$/.test(model)) return true;
    return model !== 'gpt-5.6-sol' && /^gpt-5\.6-sol[a-z0-9]+$/.test(model);
  }

  function hasTrustedNetworkEvidence(item) {
    const sources = Array.isArray(item?.sources) ? item.sources : [];
    return sources.includes('network_request_metadata')
      || sources.includes('network_response_metadata');
  }

  function evidenceLabel(model, evidence) {
    const sources = Array.isArray(evidence?.[model]?.sources) ? evidence[model].sources : [];
    if (sources.includes('network_response_metadata')) return '网络响应确认 / Response confirmed';
    if (sources.includes('network_request_metadata')) return '正式请求确认 / Request confirmed';
    return '历史识别 / Legacy discovered';
  }

  function sourceDetail(model, discoveredSet, evidence) {
    if (discoveredSet.has(model)) {
      return `${model} · 自动获取 / Auto discovered · ${evidenceLabel(model, evidence)}`;
    }
    return `${model} · 手动添加 / Manual`;
  }

  function modelLabel(value) {
    const model = normalizeConcreteModelId(value);
    if (!model) return 'Unknown';
    if (model === 'gpt-5.6-sol') return 'GPT-5.6 Sol';
    if (model === 'gpt-5.5') return 'GPT-5.5';
    if (model.startsWith('gpt-')) {
      return model
        .split('-')
        .map((part, index) => {
          if (index === 0) return 'GPT';
          if (/^\d+(?:\.\d+)*$/.test(part)) return part;
          if (part === 'sol') return 'Sol';
          return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ');
    }
    return model;
  }

  function setChoiceSource(input, discoveredSet, evidence) {
    const concrete = normalizeConcreteModelId(input?.value);
    const row = input?.closest?.('.check-row');
    if (!concrete || !row) return;
    const automatic = discoveredSet.has(concrete);
    if (automatic) row.dataset.discoveredModel = concrete;
    else delete row.dataset.discoveredModel;

    const text = row.querySelector('span');
    if (!text) return;
    let small = text.querySelector('small');
    if (!small) {
      small = document.createElement('small');
      text.append(small);
    }
    small.textContent = sourceDetail(concrete, discoveredSet, evidence);
  }

  function labelChoiceSources(discovered, evidence) {
    const container = document.getElementById('modelChoices');
    if (!container) return;
    const discoveredSet = new Set(discovered);
    for (const input of container.querySelectorAll('input[name="model"]')) {
      setChoiceSource(input, discoveredSet, evidence);
    }
  }

  function appendChoice(model, lockedModels, evidence) {
    const concrete = normalizeConcreteModelId(model);
    const container = document.getElementById('modelChoices');
    if (!container || !concrete) return;
    const discoveredSet = new Set([concrete]);
    const existing = container.querySelector(`input[name="model"][value="${CSS.escape(concrete)}"]`);
    if (existing) {
      existing.checked = lockedModels.includes(concrete);
      setChoiceSource(existing, discoveredSet, evidence);
      return;
    }

    const row = document.createElement('label');
    row.className = 'check-row';
    row.dataset.discoveredModel = concrete;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'model';
    input.value = concrete;
    input.checked = lockedModels.includes(concrete);

    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = modelLabel(concrete);
    const small = document.createElement('small');
    small.textContent = sourceDetail(concrete, discoveredSet, evidence);
    text.append(strong, small);
    row.append(input, text);
    container.append(row);
  }

  function dedupeCustomField(discovered) {
    const field = document.getElementById('customModels');
    if (!field || !field.value.trim()) return;
    const discoveredSet = new Set(discovered);
    const remaining = field.value
      .split(',')
      .map((value) => normalizeConcreteModelId(value))
      .filter((value) => value && !discoveredSet.has(value));
    field.value = [...new Set(remaining)].join(', ');
  }

  function removeDuplicateDiscoveredRows() {
    const container = document.getElementById('modelChoices');
    if (!container) return;
    for (const row of container.querySelectorAll('[data-discovered-model]')) {
      const input = row.querySelector('input[name="model"]');
      if (!input) continue;
      const duplicates = [...container.querySelectorAll('input[name="model"]')]
        .filter((candidate) => candidate.value === input.value && candidate !== input);
      if (duplicates.some((candidate) => !candidate.closest('[data-discovered-model]'))) row.remove();
    }
  }

  async function refresh() {
    const stored = await chrome.storage.sync.get([
      STORAGE_KEY,
      EVIDENCE_STORAGE_KEY,
      DISCOVERY_SCHEMA_KEY,
      'policy',
    ]);
    const discoveredRaw = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
    const discoveredBefore = [...new Set(discoveredRaw.map(normalizeModelId).filter(Boolean))];
    const lockedRaw = Array.isArray(stored.policy?.lockedModels) ? stored.policy.lockedModels : [];
    const lockedBefore = lockedRaw.map(normalizeModelId).filter(Boolean);
    const evidenceBefore = stored[EVIDENCE_STORAGE_KEY] && typeof stored[EVIDENCE_STORAGE_KEY] === 'object'
      ? stored[EVIDENCE_STORAGE_KEY]
      : {};
    const trusted = (model) => hasTrustedNetworkEvidence(evidenceBefore?.[model]);
    const discovered = discoveredBefore
      .map(normalizeConcreteModelId)
      .filter((model) => model && (!legacySuspiciousModel(model) || trusted(model)));
    const lockedModels = lockedBefore
      .map(normalizeConcreteModelId)
      .filter((model) => model && (!legacySuspiciousModel(model) || trusted(model)));
    const evidence = Object.fromEntries(
      Object.entries(evidenceBefore).filter(([model, item]) => {
        const concrete = normalizeConcreteModelId(model);
        return concrete && (!legacySuspiciousModel(concrete) || hasTrustedNetworkEvidence(item));
      }),
    );

    if (
      Number(stored[DISCOVERY_SCHEMA_KEY] || 0) < DISCOVERY_SCHEMA_VERSION
      || JSON.stringify(discovered) !== JSON.stringify(discoveredBefore)
      || JSON.stringify(lockedModels) !== JSON.stringify(lockedBefore)
      || Object.keys(evidence).length !== Object.keys(evidenceBefore).length
    ) {
      const patch = {
        [STORAGE_KEY]: discovered,
        [EVIDENCE_STORAGE_KEY]: evidence,
        [DISCOVERY_SCHEMA_KEY]: DISCOVERY_SCHEMA_VERSION,
      };
      if (stored.policy && JSON.stringify(lockedModels) !== JSON.stringify(lockedBefore)) {
        patch.policy = { ...stored.policy, lockedModels };
      }
      await chrome.storage.sync.set(patch);
    }

    for (const model of discovered) appendChoice(model, lockedModels, evidence);
    const syncChoiceUi = () => {
      labelChoiceSources(discovered, evidence);
      removeDuplicateDiscoveredRows();
      dedupeCustomField(discovered);
    };
    syncChoiceUi();
    window.setTimeout(syncChoiceUi, 0);
    window.setTimeout(syncChoiceUi, 120);
    window.setTimeout(syncChoiceUi, 800);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || (!changes[STORAGE_KEY] && !changes.policy)) return;
    void refresh().catch(() => {});
  });

  void refresh().catch(() => {});
})();
