import { privateCoreChannel } from './private-core-channel.js';
import { ChatGptNetworkMonitor } from './network-monitor.js';
import {
  applyPrivateRequestPatches,
  buildPrivateRequestPayload,
  normalizePrivateRequestDecision,
  safeRequestEndpoint,
} from './private-request-routing.js';

const PATCH_MARKER = Symbol.for('gptlock.privateRequestRouting.v3');

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error, fallback = 'private_request_authority_unavailable') {
  const code = String(error?.code || '').trim();
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code : fallback;
}

async function continueUnmodified(monitor, tabId, requestId, endpoint, reason, error = null) {
  monitor.onRewrite?.(tabId, {
    endpoint,
    changed: false,
    reason,
    error: error ? errorCode(error) : null,
  });
  try {
    await monitor.continuePaused(tabId, requestId);
  } catch (continueError) {
    monitor.onRewrite?.(tabId, {
      endpoint,
      changed: false,
      reason: 'private_request_continue_failed',
      error: errorText(continueError),
    });
  }
}

async function continueAfterDecisionFailure(monitor, tabId, requestId, endpoint, decision, initialError) {
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
  if (typeof prototype.handlePausedRequest !== 'function') return false;

  const terminalVerificationHandler = prototype.handlePausedRequest;
  Object.defineProperty(prototype, PATCH_MARKER, { value: true, configurable: false });
  prototype.handlePausedRequest = async function privateHandlePausedRequest(tabId, params = {}) {
    // Model verification has exactly one terminal mutation authority: the public
    // Fetch.requestPaused transaction handler in network-monitor.js. The private
    // normal-policy hook must never intercept that request first, otherwise it can
    // rewrite the selected verification model using the ordinary locked-model policy.
    const verification = this.verificationTransaction?.(tabId);
    if (verification?.model) {
      return terminalVerificationHandler.call(this, tabId, params);
    }

    const requestId = String(params.requestId ?? '');
    const request = params.request ?? {};
    const endpoint = safeRequestEndpoint(request.url);

    if (!(await privateCoreChannel.isAvailable())) {
      await continueUnmodified(this, tabId, requestId, endpoint, 'private_request_authority_unavailable');
      return;
    }

    let decision;
    let postData;
    try {
      postData = await this.pausedPostData(tabId, params);
      const payload = buildPrivateRequestPayload(request, postData, this.configuration());
      const windowKey = await privateCoreChannel.windowKeyForTab(tabId);
      const rawDecision = await privateCoreChannel.request('evaluate_request', payload, 'request', { windowKey });
      decision = normalizePrivateRequestDecision(rawDecision);
    } catch (error) {
      privateCoreChannel.invalidate();
      postData = null;
      await continueUnmodified(this, tabId, requestId, endpoint, 'private_request_authority_denied', error);
      return;
    }

    if (!decision.officialConversation) {
      await continueUnmodified(this, tabId, requestId, endpoint, 'private_request_not_official');
      postData = null;
      return;
    }

    let rewrittenPostData = null;
    if (decision.changed) {
      try {
        rewrittenPostData = applyPrivateRequestPatches(postData, decision.patches);
      } catch (error) {
        privateCoreChannel.invalidate();
        postData = null;
        await continueUnmodified(this, tabId, requestId, endpoint, 'private_request_decision_invalid', error);
        return;
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
      await continueAfterDecisionFailure(this, tabId, requestId, endpoint, decision, error);
    } finally {
      rewrittenPostData = null;
      postData = null;
    }
  };
  return true;
}

installPrivateRequestRoutingHook();
