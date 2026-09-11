export const DEFAULT_POLICY = Object.freeze({
  lockedModels: ['gpt-6-astra', 'gpt-5.6-sol'],
  allowedReasoningLevels: ['medium', 'high', 'extra-high'],
  strictMode: true,
});

export const DEFAULT_SETTINGS = Object.freeze({
  // A fresh install must be inert until the user signs in and explicitly enables
  // Work mode and/or Model lock. This prevents the debugger request interceptor
  // from attaching to ChatGPT during first-run account setup.
  enabled: false,
  networkVerificationEnabled: true,
  firstRequestMode: 'allow_once',
  autoAlignSelection: true,
  preferredReasoning: 'high',
});

export const KNOWN_MODELS = Object.freeze([
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
]);

export const REASONING_LEVELS = Object.freeze([
  { id: 'low', labelZh: '低', labelEn: 'Low' },
  { id: 'medium', labelZh: '中', labelEn: 'Medium' },
  { id: 'high', labelZh: '高', labelEn: 'High' },
  { id: 'extra-high', labelZh: '超高', labelEn: 'Extra High' },
]);

const MODEL_ALIASES = Object.freeze({
  'gpt-5.6-sol-wm': 'gpt-5.6-sol',
  'gpt-5-6': 'gpt-5.6-sol',
});

const NON_CONCRETE_MODEL_IDS = new Set(['auto']);
const INVALID_EXPLICIT_POLICY_FALLBACK = Object.freeze(['gpt-5.6-sol']);

const MODEL_TRANSPORT_IDS = Object.freeze({
  'gpt-5.6-sol': 'gpt-5.6-sol-wm',
});

function unique(values) {
  return [...new Set(values)];
}

function normalizeAstraFamily(model) {
  if (model === 'gpt-6-astra') return 'gpt-6-astra';
  return /^(?:gpt-6-astra)(?:[-_.:][a-z0-9._:-]+)$/.test(model) ? 'gpt-6-astra' : null;
}

export function normalizeModelId(value) {
  const model = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._:-]{1,128}$/.test(model)) return null;
  return normalizeAstraFamily(model) ?? MODEL_ALIASES[model] ?? model;
}

export function normalizeConcreteModelId(value) {
  const model = normalizeModelId(value);
  return model && !NON_CONCRETE_MODEL_IDS.has(model) ? model : null;
}

export function modelTransportId(value) {
  const model = normalizeModelId(value);
  return model ? MODEL_TRANSPORT_IDS[model] ?? model : null;
}

export function normalizeReasoningLevel(value) {
  const level = String(value ?? '').trim().toLowerCase();
  if (['extra high', 'extra_high', 'extra-high', 'xhigh'].includes(level)) return 'extra-high';
  if (level === 'extended') return 'high';
  return ['low', 'medium', 'high'].includes(level) ? level : null;
}

export function normalizePolicy(input) {
  const hasExplicitPolicy = Boolean(input && typeof input === 'object');
  const source = hasExplicitPolicy ? input : DEFAULT_POLICY;
  const rawModels = Array.isArray(source.lockedModels)
    ? source.lockedModels
    : Array.isArray(source.models)
      ? source.models
      : DEFAULT_POLICY.lockedModels;
  const rawLevels = Array.isArray(source.allowedReasoningLevels)
    ? source.allowedReasoningLevels
    : Array.isArray(source.reasoningLevels)
      ? source.reasoningLevels
      : DEFAULT_POLICY.allowedReasoningLevels;

  const lockedModels = unique(rawModels.map(normalizeConcreteModelId).filter(Boolean));
  const allowedReasoningLevels = unique(rawLevels.map(normalizeReasoningLevel).filter(Boolean));
  const fallbackModels = hasExplicitPolicy && rawModels.length
    ? INVALID_EXPLICIT_POLICY_FALLBACK
    : DEFAULT_POLICY.lockedModels;

  return {
    lockedModels: lockedModels.length ? lockedModels : [...fallbackModels],
    allowedReasoningLevels: allowedReasoningLevels.length
      ? allowedReasoningLevels
      : [...DEFAULT_POLICY.allowedReasoningLevels],
    strictMode: typeof source.strictMode === 'boolean' ? source.strictMode : DEFAULT_POLICY.strictMode,
  };
}

export function normalizeSettings(input) {
  const source = input && typeof input === 'object' ? input : DEFAULT_SETTINGS;
  return {
    enabled: typeof source.enabled === 'boolean'
      ? source.enabled
      : DEFAULT_SETTINGS.enabled,
    networkVerificationEnabled: typeof source.networkVerificationEnabled === 'boolean'
      ? source.networkVerificationEnabled
      : DEFAULT_SETTINGS.networkVerificationEnabled,
    firstRequestMode: ['allow_once', 'block'].includes(source.firstRequestMode)
      ? source.firstRequestMode
      : DEFAULT_SETTINGS.firstRequestMode,
    autoAlignSelection: typeof source.autoAlignSelection === 'boolean'
      ? source.autoAlignSelection
      : DEFAULT_SETTINGS.autoAlignSelection,
    preferredReasoning: normalizeReasoningLevel(source.preferredReasoning)
      ?? DEFAULT_SETTINGS.preferredReasoning,
  };
}
