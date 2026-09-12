(() => {
  const RUNTIME_KEY = '__GPTWORK_CONTENT_RUNTIME_LIFECYCLE_V1__';
  const HEALTH_INTERVAL_MS = 750;

  // Recovery can intentionally inject the current content bundle into an already-open
  // tab after an extension update. If this happens in the same isolated world, tear down
  // the previous generation before any later content script is evaluated again.
  try {
    globalThis[RUNTIME_KEY]?.shutdown?.('runtime_replaced');
  } catch {}

  const original = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : null,
    cancelAnimationFrame: typeof window.cancelAnimationFrame === 'function'
      ? window.cancelAnimationFrame.bind(window)
      : null,
    MutationObserver: globalThis.MutationObserver,
    addEventListener: globalThis.EventTarget?.prototype?.addEventListener,
    removeEventListener: globalThis.EventTarget?.prototype?.removeEventListener,
  };

  const timeouts = new Set();
  const intervals = new Set();
  const animationFrames = new Set();
  const observers = new Set();
  const eventListeners = new Set();
  let disposed = false;
  let terminalReason = null;
  let healthTimer = null;

  function runtimeAvailable() {
    if (disposed) return false;
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function isInvalidationError(error) {
    const message = error instanceof Error ? error.message : String(error || '');
    return /extension context invalidated|context invalidated|receiving end does not exist/i.test(message);
  }

  function removeTrackedListeners() {
    if (typeof original.removeEventListener !== 'function') return;
    for (const record of eventListeners) {
      try {
        original.removeEventListener.call(record.target, record.type, record.listener, record.options);
      } catch {}
    }
    eventListeners.clear();
  }

  function restorePatchedGlobals() {
    try {
      if (window.setTimeout === trackedSetTimeout) window.setTimeout = original.setTimeout;
      if (window.clearTimeout === trackedClearTimeout) window.clearTimeout = original.clearTimeout;
      if (window.setInterval === trackedSetInterval) window.setInterval = original.setInterval;
      if (window.clearInterval === trackedClearInterval) window.clearInterval = original.clearInterval;
      if (trackedRequestAnimationFrame && window.requestAnimationFrame === trackedRequestAnimationFrame) {
        window.requestAnimationFrame = original.requestAnimationFrame;
      }
      if (trackedCancelAnimationFrame && window.cancelAnimationFrame === trackedCancelAnimationFrame) {
        window.cancelAnimationFrame = original.cancelAnimationFrame;
      }
      if (globalThis.MutationObserver === TrackedMutationObserver) {
        globalThis.MutationObserver = original.MutationObserver;
      }
      if (globalThis.EventTarget?.prototype?.addEventListener === trackedAddEventListener) {
        globalThis.EventTarget.prototype.addEventListener = original.addEventListener;
      }
      if (globalThis.EventTarget?.prototype?.removeEventListener === trackedRemoveEventListener) {
        globalThis.EventTarget.prototype.removeEventListener = original.removeEventListener;
      }
    } catch {}
  }

  function shutdown(reason = 'terminal') {
    if (disposed) return;
    disposed = true;
    terminalReason = String(reason || 'terminal');

    if (healthTimer !== null) {
      try { original.clearInterval(healthTimer); } catch {}
      healthTimer = null;
    }
    for (const id of timeouts) {
      try { original.clearTimeout(id); } catch {}
    }
    timeouts.clear();
    for (const id of intervals) {
      try { original.clearInterval(id); } catch {}
    }
    intervals.clear();
    if (original.cancelAnimationFrame) {
      for (const id of animationFrames) {
        try { original.cancelAnimationFrame(id); } catch {}
      }
    }
    animationFrames.clear();
    for (const observer of observers) {
      try { observer.disconnect(); } catch {}
    }
    observers.clear();
    removeTrackedListeners();
    restorePatchedGlobals();

    try {
      document.getElementById('gptlock-notice-host')?.remove();
      document.getElementById('gptlock-indicator-host')?.remove();
      document.getElementById('gptlock-model-indicator-host')?.remove();
    } catch {}

    globalThis[RUNTIME_KEY] = {
      active: false,
      terminalReason,
      isAlive: () => false,
      shutdown: () => {},
    };
  }

  function checkAlive(reason = 'runtime_check') {
    if (disposed) return false;
    if (runtimeAvailable()) return true;
    shutdown(reason);
    return false;
  }

  function trackedSetTimeout(callback, delay, ...args) {
    let id = null;
    const wrapped = typeof callback === 'function'
      ? (...callbackArgs) => {
        timeouts.delete(id);
        if (!checkAlive('timeout_context_invalidated')) return undefined;
        return callback(...callbackArgs);
      }
      : callback;
    id = original.setTimeout(wrapped, delay, ...args);
    timeouts.add(id);
    return id;
  }

  function trackedClearTimeout(id) {
    timeouts.delete(id);
    return original.clearTimeout(id);
  }

  function trackedSetInterval(callback, delay, ...args) {
    const wrapped = typeof callback === 'function'
      ? (...callbackArgs) => {
        if (!checkAlive('interval_context_invalidated')) return undefined;
        return callback(...callbackArgs);
      }
      : callback;
    const id = original.setInterval(wrapped, delay, ...args);
    intervals.add(id);
    return id;
  }

  function trackedClearInterval(id) {
    intervals.delete(id);
    return original.clearInterval(id);
  }

  const trackedRequestAnimationFrame = original.requestAnimationFrame
    ? (callback) => {
      let id = null;
      id = original.requestAnimationFrame((timestamp) => {
        animationFrames.delete(id);
        if (!checkAlive('animation_frame_context_invalidated')) return;
        callback(timestamp);
      });
      animationFrames.add(id);
      return id;
    }
    : null;

  const trackedCancelAnimationFrame = original.cancelAnimationFrame
    ? (id) => {
      animationFrames.delete(id);
      return original.cancelAnimationFrame(id);
    }
    : null;

  class TrackedMutationObserver extends original.MutationObserver {
    constructor(callback) {
      super((records, observer) => {
        if (!checkAlive('mutation_context_invalidated')) return;
        callback(records, observer);
      });
      observers.add(this);
    }

    disconnect() {
      observers.delete(this);
      return super.disconnect();
    }
  }

  function trackedAddEventListener(type, listener, options) {
    if (typeof original.addEventListener !== 'function') return undefined;
    eventListeners.add({ target: this, type, listener, options });
    return original.addEventListener.call(this, type, listener, options);
  }

  function trackedRemoveEventListener(type, listener, options) {
    for (const record of eventListeners) {
      if (record.target === this && record.type === type && record.listener === listener) {
        eventListeners.delete(record);
      }
    }
    return original.removeEventListener.call(this, type, listener, options);
  }

  try {
    window.setTimeout = trackedSetTimeout;
    window.clearTimeout = trackedClearTimeout;
    window.setInterval = trackedSetInterval;
    window.clearInterval = trackedClearInterval;
    if (trackedRequestAnimationFrame) window.requestAnimationFrame = trackedRequestAnimationFrame;
    if (trackedCancelAnimationFrame) window.cancelAnimationFrame = trackedCancelAnimationFrame;
    if (original.MutationObserver) globalThis.MutationObserver = TrackedMutationObserver;
    if (globalThis.EventTarget?.prototype && typeof original.addEventListener === 'function') {
      globalThis.EventTarget.prototype.addEventListener = trackedAddEventListener;
      globalThis.EventTarget.prototype.removeEventListener = trackedRemoveEventListener;
    }
  } catch {
    // The health check below is still useful if a browser exposes any API as read-only.
  }

  // Wrap runtime messaging once for this isolated world. The wrapper turns a terminal
  // invalidation into a one-way shutdown instead of allowing every listener/timer to
  // independently throw and retry against an invalid extension context.
  try {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => {
      if (!checkAlive('send_message_context_invalidated')) {
        const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        const response = { ok: false, error: 'Extension context invalidated', terminal: true };
        if (callback) {
          queueMicrotask(() => callback(response));
          return undefined;
        }
        return Promise.resolve(response);
      }
      try {
        return originalSendMessage(...args);
      } catch (error) {
        if (isInvalidationError(error)) shutdown('send_message_context_invalidated');
        const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        const response = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          terminal: isInvalidationError(error),
        };
        if (callback) {
          queueMicrotask(() => callback(response));
          return undefined;
        }
        return Promise.resolve(response);
      }
    };
  } catch {}

  globalThis[RUNTIME_KEY] = {
    active: true,
    terminalReason: null,
    isAlive: checkAlive,
    shutdown,
  };

  // Use the original interval so shutdown can always clear this watchdog even after the
  // tracked timer APIs have been restored or the extension context has become invalid.
  healthTimer = original.setInterval(() => {
    checkAlive('health_check_context_invalidated');
  }, HEALTH_INTERVAL_MS);
})();
