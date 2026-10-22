// Passive, bounded model-origin diagnostics. Never export a conversation body,
// message text, headers, credentials, or unrecognized arbitrary metadata.
export const ORIGIN_METADATA_MAX_BYTES = 2 * 1024 * 1024;

export function modelOriginScene(model) {
  if (model === 'gpt-6-astra') return 'astra';
  if (typeof model === 'string' && /^gpt-[a-z0-9.-]+$/.test(model)) return 'non_astra';
  return 'unknown';
}

export function conversationKeyFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com') return null;
    const id = parsed.pathname.match(/(?:^|\/)c\/([a-zA-Z0-9_-]{20,})$/)?.[1];
    return id ? 'conversation:' + id : null;
  } catch {
    return null;
  }
}

export function originMetadataEndpoint(url, method) {
  if (String(method || '').toUpperCase() !== 'GET') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com') return null;
    const match = parsed.pathname.match(/^\/backend-api\/conversation\/([a-zA-Z0-9_-]{20,})\/?$/);
    if (match) return { kind: 'conversation_detail', conversationKey: 'conversation:' + match[1] };
    return null;
  } catch {
    return null;
  }
}

function modelSlug(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^gpt-[a-z0-9][a-z0-9._:-]{0,90}$/.test(text) ? text : null;
}

function pickModel(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const key of ['resolved_model_slug', 'model_slug', 'default_model_slug', 'model_id', 'model']) {
    const found = modelSlug(obj[key]);
    if (found) return { field: key, model: found };
  }
  return null;
}

export function extractOriginConversationMetadata(body) {
  if (typeof body !== 'string' || body.length > ORIGIN_METADATA_MAX_BYTES) {
    return { status: 'size_limit', fields: [] };
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { status: 'invalid_json', fields: [] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { status: 'unexpected_shape', fields: [] };
  }
  const fields = [];
  const add = (scope, object) => {
    const match = pickModel(object);
    if (match) fields.push({ scope, field: match.field, model: match.model });
  };
  // A saved conversation's model fields are NOT proof of the model that served
  // the latest request. Keep provenance separate from response verification.
  add('conversation', data);
  add('conversation_metadata', data.metadata);
  if (data.conversation && typeof data.conversation === 'object') {
    add('conversation_object', data.conversation);
    add('conversation_object_metadata', data.conversation.metadata);
  }
  const current = typeof data.current_node === 'string' ? data.current_node : null;
  const node = current && data.mapping && typeof data.mapping === 'object'
    ? data.mapping[current] : null;
  add('current_node_message_metadata', node?.message?.metadata);
  add('current_node_message', node?.message);
  return {
    status: 'parsed',
    fields: fields.slice(0, 6),
    hasCurrentNode: Boolean(current),
    hasMapping: Boolean(data.mapping && typeof data.mapping === 'object'),
  };
}

export function originSnapshotFields(observation) {
  const trace = observation?.originTrace;
  return {
    scene: modelOriginScene(observation?.model),
    model: typeof observation?.model === 'string' ? observation.model : null,
    modelEvidenceSource: String(observation?.modelEvidenceSource || 'none').slice(0, 80),
    reasoning: typeof observation?.reasoning === 'string' ? observation.reasoning : null,
    pickerAObserved: observation?.pickerA?.observed === true,
    pickerAModels: Array.isArray(observation?.pickerA?.models)
      ? observation.pickerA.models.filter((v) => /^gpt-[a-z0-9.-]+$/.test(v)).slice(0, 8) : [],
    pickerASelectedModel: observation?.pickerA?.selectedModel || null,
    composerPresent: trace?.composerPresent === true,
    modelTriggerPresent: trace?.modelTriggerPresent === true,
    modelTriggerExpanded: trace?.modelTriggerExpanded === true,
    navigationType: ['navigate', 'reload', 'back_forward', 'prerender'].includes(trace?.navigationType)
      ? trace.navigationType : 'unknown',
    readyState: ['loading', 'interactive', 'complete'].includes(trace?.readyState)
      ? trace.readyState : 'unknown',
    sinceNavigationMs: Number.isFinite(trace?.sinceNavigationMs)
      ? Math.max(0, Math.round(trace.sinceNavigationMs)) : null,
    documentTimeOrigin: Number.isFinite(trace?.documentTimeOrigin)
      ? Math.round(trace.documentTimeOrigin) : null,
  };
}
