import { capabilityLeaseEnvelope } from './capability-lease-client.js';
import { createCoreBridgeRequest, parseCoreBridgeResponse } from './core-bridge.js';

const NATIVE_HOST = 'com.gptlock.core';
const REQUEST_TIMEOUT_MS = 4500;
const CAPABILITY_TTL_MS = 30_000;
const PROTECTED_TYPES = new Set(['evaluate_request', 'evaluate_response', 'evaluate_context']);
const PRIVATE_ENGINE_FEATURES = Object.freeze([
  'requestEvaluation',
  'responseEvaluation',
  'contextBudgetEvaluation',
  'contextProfileEvaluation',
  'compactRequestPatches',
]);

export function normalizePrivateEngineCapabilities(response) {
  const engine = response?.ok === true && response?.data?.privateEngine && typeof response.data.privateEngine === 'object'
    ? response.data.privateEngine
    : {};
  const capability = {
    available: engine.available === true && Number(engine.protocolVersion) === 2,
    protocolVersion: Number(engine.protocolVersion) === 2 ? 2 : null,
    capabilityProbe: engine.capabilityProbe === true,
    capabilityLeaseRequired: engine.capabilityLeaseRequired === true,
  };
  for (const feature of PRIVATE_ENGINE_FEATURES) capability[feature] = engine[feature] === true;
  return capability;
}

export class PrivateCoreChannel {
  constructor() {
    this.port = null;
    this.sequence = 0;
    this.pending = new Map();
    this.capabilityCache = null;
  }

  connect() {
    if (this.port) return this.port;
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    this.port = port;
    port.onMessage.addListener((message) => {
      const id = String(message?.id ?? '');
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(message);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      const detail = chrome.runtime.lastError?.message || 'Private core channel disconnected';
      this.port = null;
      this.capabilityCache = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(detail));
      }
      this.pending.clear();
    });
    return port;
  }

  nextId(prefix = 'private') {
    this.sequence += 1;
    return `${prefix}-${Date.now()}-${this.sequence}`;
  }

  requestRaw(message) {
    const id = String(message?.id ?? '');
    if (!id) return Promise.reject(new TypeError('private core channel message id is required'));
    const port = this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Private core channel timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async capabilities() {
    const now = Date.now();
    if (this.capabilityCache && this.capabilityCache.expiresAt > now) {
      return this.capabilityCache.data;
    }
    try {
      const response = await this.requestRaw({ id: this.nextId('cap'), type: 'get_capabilities' });
      const data = normalizePrivateEngineCapabilities(response);
      this.capabilityCache = { data, expiresAt: now + CAPABILITY_TTL_MS };
      return data;
    } catch {
      const data = normalizePrivateEngineCapabilities(null);
      this.capabilityCache = { data, expiresAt: now + Math.min(CAPABILITY_TTL_MS, 5000) };
      return data;
    }
  }

  async isAvailable() {
    return (await this.capabilities()).available;
  }

  async supports(feature) {
    if (!PRIVATE_ENGINE_FEATURES.includes(feature)) return false;
    const capability = await this.capabilities();
    return capability.available && capability.capabilityProbe && capability[feature] === true;
  }

  async windowKeyForTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!Number.isInteger(tab?.windowId)) {
      const error = new Error('Private core request has no Chrome window binding');
      error.code = 'capability_lease_window_unavailable';
      throw error;
    }
    return `chrome:${tab.windowId}`;
  }

  async request(type, payload, prefix = 'private', context = {}) {
    const id = this.nextId(prefix);
    let message = createCoreBridgeRequest(id, type, payload);
    if (PROTECTED_TYPES.has(type)) {
      message = { ...message, ...capabilityLeaseEnvelope(context.windowKey) };
    }
    const raw = await this.requestRaw(message);
    const parsed = parseCoreBridgeResponse(raw, id);
    if (!parsed.ok) {
      this.capabilityCache = null;
      const error = new Error(parsed.error.message);
      error.code = parsed.error.code;
      throw error;
    }
    return parsed.data;
  }

  invalidate() {
    this.capabilityCache = null;
  }
}

export const privateCoreChannel = new PrivateCoreChannel();
