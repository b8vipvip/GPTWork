(() => {
  const KEY = '__GPTLOCK_PAGE_MODEL_EVIDENCE__';
  const base = globalThis[KEY];
  if (!base || base.astraPatchApplied) return;

  const ASTRA_MODEL_ID = 'gpt-6-astra';
  // Only a composer-owned CURRENT control can establish its displayed model.
  // Unselected menu choices or unrelated buttons must not override Picker A.
  const CURRENT_DISPLAY_SELECTORS = [
    "button[class*='composer-pill']",
    "button[data-testid='model-switcher-dropdown-button']",
    "[aria-checked='true']",
    "[aria-selected='true']",
    "[data-state='checked']",
    "[data-state='selected']",
    "[data-selected='true']",
  ].join(',');

  function normalizedLabel(value) {
    return String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[✓✔︎✔√]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function astraFromText(value) {
    const text = normalizedLabel(value);
    if (!text) return null;
    const compact = text.replace(/\s+/g, '-');
    if (/(?:^|[^a-z0-9])(?:gpt-)?6(?:\.0)?-astra(?=$|[^a-z0-9])/.test(compact)) return ASTRA_MODEL_ID;
    if (/(?:^|[^a-z0-9])gpt-6-astra(?:[-_.:][a-z0-9._:-]+)(?=$|[^a-z0-9])/.test(compact)) return ASTRA_MODEL_ID;
    return null;
  }

  function modelFromText(value) {
    return astraFromText(value) || base.modelFromText(value);
  }

  function currentAstraDisplay() {
    const root = base.composerRoot?.();
    if (!root) return null;
    const trigger = base.composerModelTrigger?.(root);
    const controls = [trigger, ...root.querySelectorAll(CURRENT_DISPLAY_SELECTORS)].filter(Boolean);
    const seen = new Set();
    for (const element of controls) {
      if (seen.has(element) || !base.visible(element)) continue;
      seen.add(element);
      const label = base.evidenceValues(element).find(astraFromText);
      if (!label) continue;
      return {
        model: ASTRA_MODEL_ID,
        source: 'composer-current-display',
        label,
        ambiguous: false,
        candidates: [ASTRA_MODEL_ID],
      };
    }
    return null;
  }

  function modelEvidence() {
    return currentAstraDisplay() || base.modelEvidence();
  }

  function collect() {
    const model = modelEvidence();
    const reasoning = base.reasoningEvidence();
    const catalog = base.officialPickerACatalogEvidence?.();
    return {
      model: model.model,
      reasoning: reasoning.reasoning,
      modelSource: model.source,
      reasoningSource: reasoning.source,
      modelLabel: model.label,
      reasoningLabel: reasoning.label,
      ambiguous: model.ambiguous,
      candidates: model.candidates,
      pickerA: catalog
        ? { observed: true, source: catalog.source, models: catalog.models,
            selectedModel: catalog.selectedModel, ambiguousSelection: catalog.ambiguousSelection }
        : { observed: false, source: 'not_observed', models: [],
            selectedModel: null, ambiguousSelection: false },
    };
  }

  globalThis[KEY] = Object.freeze({
    ...base,
    version: '1.3.0-astra',
    astraPatchApplied: true,
    astraFromText,
    modelFromText,
    modelEvidence,
    collect,
  });
})();
