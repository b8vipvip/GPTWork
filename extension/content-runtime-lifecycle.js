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
    PerformanceObserver: globalThis.PerformanceObserver,
    ResizeObserver: globalThis.ResizeObserver,
    addEventListener: globalThis.EventTarget?.prototype?.addEventListener,
    removeEventListener: globalThis.EventTarget?.prototype?.removeEventListener,
    sendMessage: globalThis.chrome?.runtime?.sendMessage,
  };

  const timeouts = new Set();
  const intervals = new Set();
  const animationFrames = new Set();
  const observers = new Set();
  const performanceObservers = new Set();
  const resizeObservers = new Set();
  const eventListeners = new Set();
  const chromeEventListeners = new Set();
  const chromeEventPatches = [];
  let disposed = false;
  let terminalReason = null;
  let healthTimer = null;
  const callbackStats = new Map();

  function measureCallback(kind, callback, args) {
    const startedAt = performance.now();
    try {
      return callback(...args);
    } finally {
      const elapsed = Math.max(0, performance.now() - startedAt);
      const current = callbackStats.get(kind) || { count: 0, totalMs: 0, maxMs: 0 };
      current.count += 1;
      current.totalMs += elapsed;
      current.maxMs = Math.max(current.maxMs, elapsed);
      callbackStats.set(kind, current);
    }
  }

  function diagnosticsSnapshot({ resetCallbacks = false } = {}) {
    const callbacks = {};
    for (const [kind, value] of callbackStats) {
      callbacks[kind] = {
        count: value.count,
        totalMs: Math.round(value.totalMs * 10) / 10,
        maxMs: Math.round(value.maxMs * 10) / 10,
      };
    }
    const snapshot = {
      active: !disposed,
      terminalReason,
      live: {
        timeouts: timeouts.size,
        intervals: intervals.size,
        animationFrames: animationFrames.size,
        mutationObservers: observers.size,
        performanceObservers: performanceObservers.size,
        resizeObservers: resizeObservers.size,
        domEventListeners: eventListeners.size,
        chromeEventListeners: chromeEventListeners.size,
      },
      callbacks,
    };
    if (resetCallbacks) callbackStats.clear();
    return snapshot;
  }

  function runtimeAvailable() {
    if (disposed) return false;
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function errorText(error) {
    return error instanceof Error ? error.message : String(error?.message || error || '');
  }

  function isInvalidationError(error) {
    const message = errorText(error);
    // A missing message receiver is not proof that this content-script generation is
    // invalid. During service-worker startup or page navigation Chrome can transiently
    // report "Receiving end does not exist" while chrome.runtime.id is still healthy.
    // Only true extension-context invalidation is terminal here; the health watchdog
    // separately detects a missing/throwing runtime.id.
    return /extension context invalidated|context invalidated|chrome-extension:\/\/invalid\//i.test(message);
  }

  function terminalFailure(error) {
    return {
      ok: false,
      error: errorText(error) || 'Extension context invalidated',
      terminal: true,
    };
  }

  function removeTrackedListeners() {
    if (typeof original.removeEventListener !== 'function') return;
    for (const record of eventListeners) {
      try {
        original.removeEventListener.call(record.target, record.type, record.wrapped || record.listener, record.options);
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
      if (TrackedPerformanceObserver && globalThis.PerformanceObserver === TrackedPerformanceObserver) {
        globalThis.PerformanceObserver = original.PerformanceObserver;
      }
      if (TrackedResizeObserver && globalThis.ResizeObserver === TrackedResizeObserver) {
        globalThis.ResizeObserver = original.ResizeObserver;
      }
      if (globalThis.EventTarget?.prototype?.addEventListener === trackedAddEventListener) {
        globalThis.EventTarget.prototype.addEventListener = original.addEventListener;
      }
      if (globalThis.EventTarget?.prototype?.removeEventListener === trackedRemoveEventListener) {
        globalThis.EventTarget.prototype.removeEventListener = original.removeEventListener;
      }
      for (const patch of chromeEventPatches) {
        if (patch.event?.addListener === patch.trackedAdd) patch.event.addListener = patch.add;
        if (patch.event?.removeListener === patch.trackedRemove) patch.event.removeListener = patch.remove;
      }
      chromeEventPatches.length = 0;
      if (globalThis.chrome?.runtime?.sendMessage === trackedSendMessage && typeof original.sendMessage === 'function') {
        globalThis.chrome.runtime.sendMessage = original.sendMessage;
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
    for (const observer of performanceObservers) {
      try { observer.disconnect(); } catch {}
    }
    performanceObservers.clear();
    for (const observer of resizeObservers) {
      try { observer.disconnect(); } catch {}
    }
    resizeObservers.clear();
    removeTrackedListeners();
    for (const record of chromeEventListeners) {
      try { record.remove.call(record.event, record.wrapped || record.listener); } catch {}
    }
    chromeEventListeners.clear();
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
        return measureCallback('timeout', callback, callbackArgs);
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
        return measureCallback('interval', callback, callbackArgs);
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
        measureCallback('animationFrame', callback, [timestamp]);
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
        measureCallback('mutationObserver', callback, [records, observer]);
      });
      observers.add(this);
    }

    disconnect() {
      observers.delete(this);
      return super.disconnect();
    }
  }

  const TrackedPerformanceObserver = original.PerformanceObserver
    ? class extends original.PerformanceObserver {
      constructor(callback) {
        super((entries, observer) => {
          if (!checkAlive('performance_observer_context_invalidated')) return;
          measureCallback('performanceObserver', callback, [entries, observer]);
        });
        performanceObservers.add(this);
      }
      disconnect() {
        performanceObservers.delete(this);
        return super.disconnect();
      }
    }
    : null;

  const TrackedResizeObserver = original.ResizeObserver
    ? class extends original.ResizeObserver {
      constructor(callback) {
        super((entries, observer) => {
          if (!checkAlive('resize_observer_context_invalidated')) return;
          measureCallback('resizeObserver', callback, [entries, observer]);
        });
        resizeObservers.add(this);
      }
      disconnect() {
        resizeObservers.delete(this);
        return super.disconnect();
      }
    }
    : null;

  function trackedAddEventListener(type, listener, options) {
    if (typeof original.addEventListener !== 'function') return undefined;
    const capture = typeof options === 'boolean' ? options : options?.capture === true;
    const existing = [...eventListeners].find((record) => (
      record.target === this
      && record.type === type
      && record.listener === listener
      && record.capture === capture
    ));
    if (existing) return original.addEventListener.call(this, type, existing.wrapped || listener, options);
    let wrapped = listener;
    if (typeof listener === 'function') {
      wrapped = function measuredDomEventListener(...args) {
        return measureCallback('domEvent', listener.bind(this), args);
      };
    } else if (listener && typeof listener.handleEvent === 'function') {
      wrapped = {
        handleEvent(...args) {
          return measureCallback('domEvent', listener.handleEvent.bind(listener), args);
        },
      };
    }
    eventListeners.add({ target: this, type, listener, wrapped, options, capture });
    return original.addEventListener.call(this, type, wrapped, options);
  }

  function trackedRemoveEventListener(type, listener, options) {
    let wrapped = listener;
    for (const record of eventListeners) {
      if (record.target === this && record.type === type && record.listener === listener) {
        wrapped = record.wrapped || listener;
        eventListeners.delete(record);
      }
    }
    return original.removeEventListener.call(this, type, wrapped, options);
  }

  function patchChromeEvent(event) {
    if (!event || typeof event.addListener !== 'function' || typeof event.removeListener !== 'function') return;
    const add = event.addListener;
    const remove = event.removeListener;
    const trackedAdd = function trackedChromeAddListener(listener) {
      if (typeof listener !== 'function') return add.call(event, listener);
      const wrapped = function measuredChromeEventListener(...args) {
        return measureCallback('chromeEvent', listener, args);
      };
      chromeEventListeners.add({ event, listener, wrapped, remove });
      return add.call(event, wrapped);
    };
    const trackedRemove = function trackedChromeRemoveListener(listener) {
      let wrapped = listener;
      for (const record of chromeEventListeners) {
        if (record.event === event && record.listener === listener) {
          wrapped = record.wrapped || listener;
          chromeEventListeners.delete(record);
        }
      }
      return remove.call(event, wrapped);
    };
    try {
      event.addListener = trackedAdd;
      event.removeListener = trackedRemove;
      chromeEventPatches.push({ event, add, remove, trackedAdd, trackedRemove });
    } catch {}
  }

  function trackedSendMessage(...args) {
    const callbackIndex = typeof args[args.length - 1] === 'function' ? args.length - 1 : -1;
    const callback = callbackIndex >= 0 ? args[callbackIndex] : null;

    if (!checkAlive('send_message_context_invalidated')) {
      const response = terminalFailure('Extension context invalidated');
      if (callback) {
        queueMicrotask(() => callback(response));
        return undefined;
      }
      return Promise.resolve(response);
    }

    if (callback) {
      const forwardedArgs = [...args];
      forwardedArgs[callbackIndex] = (...callbackArgs) => {
        let runtimeError = null;
        try { runtimeError = globalThis.chrome?.runtime?.lastError || null; } catch {}
        if (runtimeError && isInvalidationError(runtimeError)) {
          const response = terminalFailure(runtimeError);
          shutdown('send_message_async_context_invalidated');
          callback(response);
          return;
        }
        callback(...callbackArgs);
      };
      try {
        return original.sendMessage.apply(globalThis.chrome.runtime, forwardedArgs);
      } catch (error) {
        const terminal = isInvalidationError(error);
        if (terminal) {
          shutdown('send_message_context_invalidated');
          queueMicrotask(() => callback(terminalFailure(error)));
          return undefined;
        }
        throw error;
      }
    }

    try {
      const result = original.sendMessage.apply(globalThis.chrome.runtime, args);
      if (!result || typeof result.then !== 'function') return result;
      return result.catch((error) => {
        if (!isInvalidationError(error)) throw error;
        shutdown('send_message_async_context_invalidated');
        return terminalFailure(error);
      });
    } catch (error) {
      const terminal = isInvalidationError(error);
      if (!terminal) throw error;
      shutdown('send_message_context_invalidated');
      return Promise.resolve(terminalFailure(error));
    }
  }

  try {
    window.setTimeout = trackedSetTimeout;
    window.clearTimeout = trackedClearTimeout;
    window.setInterval = trackedSetInterval;
    window.clearInterval = trackedClearInterval;
    if (trackedRequestAnimationFrame) window.requestAnimationFrame = trackedRequestAnimationFrame;
    if (trackedCancelAnimationFrame) window.cancelAnimationFrame = trackedCancelAnimationFrame;
    if (original.MutationObserver) globalThis.MutationObserver = TrackedMutationObserver;
    if (TrackedPerformanceObserver) globalThis.PerformanceObserver = TrackedPerformanceObserver;
    if (TrackedResizeObserver) globalThis.ResizeObserver = TrackedResizeObserver;
    if (globalThis.EventTarget?.prototype && typeof original.addEventListener === 'function') {
      globalThis.EventTarget.prototype.addEventListener = trackedAddEventListener;
      globalThis.EventTarget.prototype.removeEventListener = trackedRemoveEventListener;
    }
  } catch {
    // The health check below is still useful if a browser exposes any API as read-only.
  }

  patchChromeEvent(globalThis.chrome?.runtime?.onMessage);
  patchChromeEvent(globalThis.chrome?.storage?.onChanged);

  // Wrap runtime messaging once for this isolated world. The wrapper turns a terminal
  // invalidation into a one-way shutdown instead of allowing every listener/timer to
  // independently throw and retry against an invalid extension context. It is restored
  // only when this generation still owns the wrapper, so a newer generation is never
  // clobbered by stale shutdown work.
  try {
    if (typeof original.sendMessage === 'function') {
      globalThis.chrome.runtime.sendMessage = trackedSendMessage;
    }
  } catch {}

  globalThis[RUNTIME_KEY] = {
    active: true,
    terminalReason: null,
    isAlive: checkAlive,
    shutdown,
    diagnosticsSnapshot,
  };

  // The background lifecycle authority can quiesce every content generation before an
  // extension reload/update. Respond first so the service worker can continue its one
  // shutdown sequence, then make this content generation terminal.
  try {
    globalThis.chrome?.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
      if (message?.type !== 'GPTWORK_CONTENT_PREPARE_RELOAD') return false;
      try { sendResponse({ ok: true, data: { quiesced: true } }); } catch {}
      queueMicrotask(() => shutdown('extension_reload_prepare'));
      return false;
    });
  } catch {}

  // Use the original interval so shutdown can always clear this watchdog even after the
  // tracked timer APIs have been restored or the extension context has become invalid.
  healthTimer = original.setInterval(() => {
    checkAlive('health_check_context_invalidated');
  }, HEALTH_INTERVAL_MS);
})();