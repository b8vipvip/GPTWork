(() => {
  const KEY = '__GPTLOCK_PAGE_MODEL_EVIDENCE__';
  if (globalThis[KEY]) return;

  const MODEL_ALIASES = Object.freeze({
    'gpt-5.6-sol-wm': 'gpt-5.6-sol',
    'gpt-5.6-terra-wm': 'gpt-5.6-terra',
    'gpt-5.6-luna-wm': 'gpt-5.6-luna',
    'gpt-6-astra-wm': 'gpt-6-astra',
    'gpt-6-sol-wm': 'gpt-6-sol',
    'gpt-6-luna-wm': 'gpt-6-luna',
    'gpt-5-6': 'gpt-5.6-sol',
  });
  const FAMILY_ALIASES = Object.freeze({
    'gpt-5.6-sol': ['gpt-5.6 sol', 'gpt 5.6 sol', '5.6 sol'],
    'gpt-5.6-terra': ['gpt-5.6 terra', 'gpt 5.6 terra', '5.6 terra'],
    'gpt-5.6-luna': ['gpt-5.6 luna', 'gpt 5.6 luna', '5.6 luna'],
    'gpt-5.5': ['gpt-5.5', 'gpt 5.5', '5.5'],
    'gpt-6-astra': ['gpt-6 astra', 'gpt 6 astra', '6 astra'],
    'gpt-6-sol': ['gpt-6 sol', 'gpt 6 sol', '6 sol'],
    'gpt-6-luna': ['gpt-6 luna', 'gpt 6 luna', '6 luna'],
  });
  const REASONING_ALIASES = Object.freeze({
    'extra-high': ['extra high', 'extra-high', 'xhigh', '超高'],
    high: ['high', '高级', '高'],
    medium: ['medium', '中级', '中等', '中'],
    low: ['low', '低级', '低', '极速', 'instant', 'fast', 'minimal'],
  });
  const COMPOSER_ROOT_SELECTORS = Object.freeze([
    "form[data-type='unified-composer']",
    'form',
  ]);
  const COMPOSER_SELECTORS = Object.freeze([
    '#prompt-textarea',
    'textarea[placeholder]',
    "div[contenteditable='true'][data-lexical-editor='true']",
    "div[contenteditable='true'].ProseMirror",
    "form div[contenteditable='true']",
    "[contenteditable='true']",
  ]);
  const SELECTED_MODEL_SELECTORS = Object.freeze([
    "[aria-checked='true']",
    "[aria-selected='true']",
    "[data-state='checked']",
    "[data-state='selected']",
    "[data-selected='true']",
    "button[class*='composer-pill']",
    "button[data-testid*='model' i]",
  ]);
  const MODEL_ATTRIBUTE_NAMES = Object.freeze([
    'data-model',
    'data-model-id',
    'data-value',
    'aria-label',
    'title',
  ]);

  function normalize(value) {
    return String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeLabel(value) {
    return normalize(value).replace(/[✓✔︎✔√]/g, '').trim();
  }

  function normalizedLabelLower(value) {
    return normalizeLabel(value).toLowerCase();
  }

  function visible(element) {
    if (!element?.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden';
  }

  function evidenceValues(element) {
    if (!element) return [];
    const values = [
      ...MODEL_ATTRIBUTE_NAMES.map((name) => element.getAttribute?.(name) || ''),
      element.innerText || '',
      element.textContent || '',
    ]
      .map(normalizeLabel)
      .filter(Boolean);
    return [...new Set(values)];
  }

  function labelOf(element) {
    const values = evidenceValues(element);
    const visibleText = normalizeLabel(element?.innerText || element?.textContent || '');
    return visibleText || values[0] || '';
  }

  function normalizeModelId(value) {
    const model = String(value ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._:-]{1,128}$/.test(model)) return null;
    return MODEL_ALIASES[model] ?? model;
  }

  function aliasMatches(text, alias) {
    const haystack = normalizedLabelLower(text);
    const needle = normalizedLabelLower(alias);
    if (!needle) return false;
    let offset = haystack.indexOf(needle);
    while (offset >= 0) {
      const before = offset > 0 ? haystack[offset - 1] : '';
      const afterIndex = offset + needle.length;
      const after = afterIndex < haystack.length ? haystack[afterIndex] : '';
      const boundedBefore = !before || !/[a-z0-9.]/i.test(before);
      const boundedAfter = !after || !/[a-z0-9.]/i.test(after);
      if (boundedBefore && boundedAfter) return true;
      offset = haystack.indexOf(needle, offset + 1);
    }
    return false;
  }

  function modelFromText(value) {
    const text = normalizedLabelLower(value);
    if (!text) return null;

    for (const [family, aliases] of Object.entries(FAMILY_ALIASES)) {
      if (aliases.some((alias) => normalizedLabelLower(alias) === text)) return family;
    }

    const compact = text.replace(/\s+/g, '-');
    const futureTier = compact.match(/^gpt-?(\d+(?:\.\d+)*)-([a-z][a-z0-9]{1,31})(?:-wm)?$/);
    if (futureTier) return normalizeModelId(`gpt-${futureTier[1]}-${futureTier[2]}`);
    const compactTier = compact.match(/(?:^|[^a-z0-9])(?:gpt-)?(\d+(?:\.\d+)*)-(astra|pro|sol|terra|luna)(?:-wm)?(?:$|[^a-z0-9])/);
    if (compactTier) return normalizeModelId(`gpt-${compactTier[1]}-${compactTier[2]}`);
    // A bare family label is valid, but lifecycle/help copy mentioning a model is not.
    // The redesigned picker also shows GPT-5.5 as "5.5 高" (reasoning suffix).
    const bareFamily = compact.match(/^gpt-?(\d+(?:\.\d+)*)$/);
    if (bareFamily) return normalizeModelId(`gpt-${bareFamily[1]}`);
    const compact55 = compact.match(/^5\.5(?:-(?:高|中|低|high|medium|low|extra-high))?$/);
    return compact55 ? 'gpt-5.5' : null;
  }

  function reasoningFromText(value) {
    const text = normalizedLabelLower(value);
    if (!text) return null;
    for (const [level, aliases] of Object.entries(REASONING_ALIASES)) {
      if (aliases.some((alias) => {
        const needle = normalizedLabelLower(alias);
        return text === needle
          || text.startsWith(`${needle} `)
          || text.endsWith(` ${needle}`);
      })) return level;
    }
    return null;
  }

  function composerRoot() {
    for (const selector of COMPOSER_ROOT_SELECTORS) {
      const root = [...document.querySelectorAll(selector)].find((form) =>
        visible(form) && COMPOSER_SELECTORS.some((composerSelector) => form.querySelector(composerSelector)),
      );
      if (root) return root;
    }
    return null;
  }

  function parseControl(element) {
    const values = evidenceValues(element);
    const modelValue = values.find((value) => modelFromText(value));
    const reasoningValue = values.find((value) => reasoningFromText(value));
    const model = modelValue ? modelFromText(modelValue) : null;
    const reasoning = reasoningValue ? reasoningFromText(reasoningValue) : null;
    return {
      element,
      values,
      label: modelValue || reasoningValue || labelOf(element),
      model,
      reasoning,
    };
  }

  function modelReasoningControls() {
    const root = composerRoot();
    if (!root) return [];
    return [...root.querySelectorAll("button,[role='button'],[aria-label],[data-value],[data-model],[data-model-id]")]
      .filter(visible)
      .map(parseControl)
      .filter((item) => item.model || item.reasoning);
  }

  function composerModelTrigger(root = composerRoot()) {
    if (!root) return null;
    return [...root.querySelectorAll("button[aria-haspopup='menu'],[role='button'][aria-haspopup='menu']")]
      .filter(visible)
      .find((element) => /(?:select|choose).*model|model.*selector|选择.*模型|模型.*选择/i.test(
        String(element.getAttribute?.('aria-label') || element.getAttribute?.('title') || ''),
      )) || null;
  }

  const DIRECT_CHAT_PICKER_A_MODELS = new Set(['gpt-6', 'gpt-5.6-sol', 'gpt-5.5']);
  const RECENT_CHECKED_PICKER_MAX_AGE_MS = 2 * 60 * 1000;
  let recentCheckedPicker = null;

  function lastObservedOfficialPickerA() {
    if (!recentCheckedPicker || Date.now() - recentCheckedPicker.at > RECENT_CHECKED_PICKER_MAX_AGE_MS) return null;
    const pathname = globalThis.location?.pathname || '';
    if (recentCheckedPicker.pathname !== pathname) {
      // The user's checked Picker A row on the ChatGPT home composer belongs
      // to the first conversation created from that same live page. Preserve
      // only that one-way / -> /c/:id SPA transition, never /c/:a -> /c/:b.
      if (recentCheckedPicker.pathname === '/' && /^\/c\/[a-z0-9_-]+$/i.test(pathname)) {
        recentCheckedPicker.pathname = pathname;
      } else {
        return null;
      }
    }
    return {
      model: recentCheckedPicker.model,
      source: 'official-picker-a-last-checked',
      label: recentCheckedPicker.label,
      ambiguous: false,
      candidates: [recentCheckedPicker.model],
    };
  }

  function selectedOfficialPickerAEvidence() {
    const trigger = composerModelTrigger();
    // Only inspect an actively opened model picker owned by the composer.
    // Radix may portal its menu outside the composer form.
    if (!trigger || trigger.getAttribute?.('aria-expanded') !== 'true') return null;
    const controlledId = trigger.getAttribute?.('aria-controls') || '';
    const controlled = controlledId ? document.getElementById(controlledId) : null;
    // The open composer trigger must own the inspected menu through its
    // aria-controls relation.  Scanning unrelated visible portal menus could
    // accidentally report another control's checked GPT row as Picker A.
    const scopes = controlled && visible(controlled) ? [controlled] : [];

    for (const scope of scopes) {
      const rows = [...scope.querySelectorAll(
        "[role='menuitemradio'],[role='radio'],[role='option'],[data-testid^='model-switcher-'],[data-model],[data-model-id]"
      )].filter(visible).map((element) => {
        const values = evidenceValues(element);
        const testId = element.getAttribute?.('data-testid') || '';
        const testIdModel = /^model-switcher-(gpt-[a-z0-9._:-]+)$/i.exec(testId)?.[1] || '';
        // Live Picker A rows may append retirement copy beneath a known
        // family label (e.g. "GPT-5.5 Leaving on October 14").  Parse that
        // ONLY inside the composer-owned official menu, never from arbitrary
        // page help text or as a new, invented model family.
        const rowLabel = labelOf(element);
        const lifecycle55 = /^gpt[- ]?5\.5\s+leaving\s+on\s+[a-z0-9 ,/-]+$/i.test(rowLabel)
          ? 'gpt-5.5' : null;
        const model = [testIdModel, ...values].map(modelFromText).find(Boolean) || lifecycle55;
        const checked = element.getAttribute?.('aria-checked') === 'true'
          || element.getAttribute?.('aria-selected') === 'true'
          || element.getAttribute?.('data-state') === 'checked'
          || element.getAttribute?.('data-state') === 'selected'
          || element.getAttribute?.('data-selected') === 'true';
        return { element, model, checked, label: labelOf(element) };
      });
      const models = [...new Set(rows.map((row) => row.model).filter(Boolean))];
      // A menu with a single GPT-labelled command is not the Picker A model
      // catalog. Also reject Work / Picker B and non-model menu structures.
      if (models.length < 2 || models.some((model) => !DIRECT_CHAT_PICKER_A_MODELS.has(model))) continue;
      const selected = rows.filter((row) => row.model && row.checked);
      const selectedModels = [...new Set(selected.map((row) => row.model))];
      if (selectedModels.length !== 1) continue;
      const selectedRow = selected.find((row) => row.model === selectedModels[0]);
      recentCheckedPicker = {
        model: selectedModels[0],
        label: selectedRow?.label || selectedModels[0],
        pathname: globalThis.location?.pathname || '',
        at: Date.now(),
      };
      return {
        model: selectedModels[0],
        source: 'official-picker-a-checked',
        label: selectedRow?.label || selectedModels[0],
        ambiguous: false,
        candidates: models,
      };
    }
    return null;
  }

  function redesignedDefaultChatEvidence() {
    const root = composerRoot();
    const trigger = composerModelTrigger(root);
    if (!trigger) return null;

    const triggerValues = evidenceValues(trigger);
    const triggerModelValue = triggerValues.find((value) => modelFromText(value));
    if (triggerModelValue) {
      return {
        model: modelFromText(triggerModelValue),
        source: 'composer-trigger',
        label: triggerModelValue,
        inferred: false,
      };
    }

    const triggerText = normalizeLabel(trigger.innerText || trigger.textContent || '');
    const expanded = trigger.getAttribute?.('aria-expanded') === 'true';
    if (!expanded) {
      // "High" / "Medium" denotes reasoning effort, not a unique model.
      // Live GPT-6 and GPT-5.6 Sol share this reasoning-only composer pill.
      return null;
    }

    const controlledId = trigger.getAttribute?.('aria-controls') || '';
    const popup = controlledId ? document.getElementById(controlledId) : null;
    if (!popup || !visible(popup)) return null;
    const popupText = normalizeLabel(popup.innerText || popup.textContent || '');
    const hasSol = FAMILY_ALIASES['gpt-5.6-sol'].some((alias) => aliasMatches(popupText, alias));
    const has55 = FAMILY_ALIASES['gpt-5.5'].some((alias) => aliasMatches(popupText, alias));
    if (!hasSol || !has55) return null;

    const opener = [...popup.querySelectorAll("[role='menuitem'],button,[role='button']")]
      .filter(visible)
      .find((element) => /^(?:select model|choose model|选择模型|選擇模型|모델 선택)$/i.test(
        String(element.getAttribute?.('aria-label') || element.getAttribute?.('title') || '').trim(),
      ));
    if (!opener) return null;
    const openerValues = evidenceValues(opener);
    const openerModelValue = openerValues.find((value) => modelFromText(value));
    if (openerModelValue) {
      return {
        model: modelFromText(openerModelValue),
        source: 'open-picker-summary',
        label: openerModelValue,
        inferred: false,
      };
    }
    // A reasoning-only menu summary is not a model identity. Prefer the
    // exact checked model row from the owned Picker A menu or report unknown.
    return null;
  }

  function modelEvidence() {
    const checkedPicker = selectedOfficialPickerAEvidence();
    if (checkedPicker) return checkedPicker;
    const root = composerRoot() || document;
    const rows = [];
    const seen = new Set();

    for (const selector of SELECTED_MODEL_SELECTORS) {
      for (const element of root.querySelectorAll(selector)) {
        if (seen.has(element) || !visible(element)) continue;
        seen.add(element);
        const parsed = parseControl(element);
        if (parsed.model) {
          rows.push({
            model: parsed.model,
            source: 'composer-dom',
            label: parsed.values.find((value) => modelFromText(value) === parsed.model) || parsed.label,
            selected: true,
            combined: Boolean(parsed.reasoning),
          });
        }
      }
    }

    for (const item of modelReasoningControls()) {
      if (item.model) {
        rows.push({
          model: item.model,
          source: 'composer-dom',
          label: item.values.find((value) => modelFromText(value) === item.model) || item.label,
          selected: false,
          combined: Boolean(item.reasoning),
        });
      }
    }

    const preferredRows = rows.filter((row) => row.selected || row.combined);
    const preferredModels = [...new Set(preferredRows.map((item) => item.model).filter(Boolean))];
    const models = [...new Set(rows.map((item) => item.model).filter(Boolean))];
    const effectiveModels = preferredModels.length === 1 ? preferredModels : models;

    if (effectiveModels.length === 1) {
      const model = effectiveModels[0];
      const row = preferredRows.find((item) => item.model === model)
        || rows.find((item) => item.model === model);
      return {
        model,
        source: row?.source || 'composer-dom',
        label: row?.label || '',
        ambiguous: false,
        candidates: models,
      };
    }

    if (effectiveModels.length === 0) {
      const redesigned = redesignedDefaultChatEvidence();
      if (redesigned?.model) {
        return {
          model: redesigned.model,
          source: redesigned.source,
          label: redesigned.label || '',
          ambiguous: false,
          candidates: [redesigned.model],
        };
      }
      // Closing Radix hides the checked row and exposes only "High".
      // Retain the most recent *actually checked* model for this conversation
      // briefly, explicitly marked as historical page observation rather than
      // a live or network-confirmed model identity.
      const lastChecked = lastObservedOfficialPickerA();
      if (lastChecked) return lastChecked;
    }

    return {
      model: null,
      source: effectiveModels.length > 1 ? 'ambiguous-dom' : 'none',
      label: '',
      ambiguous: effectiveModels.length > 1,
      candidates: models,
    };
  }

  function reasoningEvidence() {
    const candidates = modelReasoningControls().filter((item) => item.reasoning);
    if (!candidates.length) return { reasoning: null, source: 'none', label: '' };
    const combined = candidates.find((item) => item.model);
    const item = combined || candidates[0];
    return {
      reasoning: item.reasoning,
      source: 'composer-dom',
      label: item.values.find((value) => reasoningFromText(value) === item.reasoning) || item.label,
    };
  }

  function collect() {
    const model = modelEvidence();
    const reasoning = reasoningEvidence();
    return {
      model: model.model,
      reasoning: reasoning.reasoning,
      modelSource: model.source,
      reasoningSource: reasoning.source,
      modelLabel: model.label,
      reasoningLabel: reasoning.label,
      ambiguous: model.ambiguous,
      candidates: model.candidates,
    };
  }

  globalThis[KEY] = Object.freeze({
    version: '1.3.0',
    composerRoot,
    selectedOfficialPickerAEvidence,
    evidenceValues,
    labelOf,
    visible,
    modelFromText,
    reasoningFromText,
    modelReasoningControls,
    modelEvidence,
    reasoningEvidence,
    collect,
  });
})();
