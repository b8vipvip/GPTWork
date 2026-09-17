import { privateCoreChannel } from './private-core-channel.js';
import { ChatGptNetworkMonitor } from './network-monitor.js';
import {
  applyPrivateRequestPatches,
  buildPrivateRequestPayload,
  normalizePrivateRequestDecision,
  safeRequestEndpoint,
} from './private-request-routing.js';

const PATCH_MARKER = Symbol.for('gptlock.privateRequestRouting.v2');

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function continueFailOpen(monitor, tabId, requestId, endpoint, decision, initialError) {
  monitor.onRewrite?.(tabId, {
    endpoint,
    changed: false,
    reason: 'private_request_continue_failed_open',
    modelBefore: decision?.modelBefore ?? null,
    modelAfter: decision?.modelAfter ?? null,
    error: errorText(initialError),
  });
  try {
    await monitor.continuePaused(tabId, requestId);
  } catch (continueError) {
    monitor.onRewrite?.(tabId, {
      endpoint,
      changed: false,
      reason: 'private_request_fail_open_continue_failed',
      error: errorText(continueError),
    });
  }
}

export function installPrivateRequestRoutingHook() {
  const prototype = ChatGptNetworkMonitor.prototype;
  if (prototype[PATCH_MARKER]) return false;
  const legacyHandlePausedRequest = prototype.handlePausedRequest;
  if (typeof legacyHandlePausedRequest !== 'function') return false;

  Object.defineProperty(prototype, PATCH_MARKER, { value: true, configurable: false });
  prototype.handlePausedRequest = async function privateHandlePausedRequest(tabId, params = {}) {
    if (!(await privateCoreChannel.isAvailable())) {
      return legacyHandlePausedRequest.call(this, tabId, params);
    }

    const requestId = String(params.requestId ?? '');
    const request = params.request ?? {};
    const endpoint = safeRequestEndpoint(request.url);
    let decision;
    let postData;
    try {
      postData = await this.pausedPostData(tabId, params);
      const payload = buildPrivateRequestPayload(request, postData, this.configuration());
      const windowKey = await privateCoreChannel.windowKeyForTab(tabId);
      const rawDecision = await privateCoreChannel.request('evaluate_request', payload, 'request', { windowKey });
      decision = normalizePrivateRequestDecision(rawDecision);
    } catch {
      privateCoreChannel.invalidate();
      return legacyHandlePausedRequest.call(this, tabId, params);
    }

    if (!decision.officialConversation) {
      try {
        await this.continuePaused(tabId, requestId);
      } catch (error) {
        this.onRewrite?.(tabId, {
          endpoint,
          changed: false,
          reason: 'continue_failed',
          error: errorText(error),
        });
      }
      return;
    }

    let rewrittenPostData = null;
    if (decision.changed) {
      try {
        rewrittenPostData = applyPrivateRequestPatches(postData, decision.patches);
      } catch {
        privateCoreChannel.invalidate();
        return legacyHandlePausedRequest.call(this, tabId, params);
      }
    }

    try {
      await this.continuePaused(tabId, requestId, rewrittenPostData);
      this.onRewrite?.(tabId, {
        endpoint,
        changed: decision.changed,
        reason: decision.reason,
        modelBefore: decision.modelBefore,
        modelAfter: decision.modelAfter,
        transportModelBefore: decision.transportModelBefore,
        transportModelAfter: decision.transportModelAfter,
        reasoningBefore: decision.reasoningBefore,
        reasoningAfter: decision.reasoningAfter,
        reasoningFields: decision.reasoningFields,
      });
    } catch (error) {
      await continueFailOpen(this, tabId, requestId, endpoint, decision, error);
    } finally {
      rewrittenPostData = null;
      postData = null;
    }
  };
  return true;
}

installPrivateRequestRoutingHook();
