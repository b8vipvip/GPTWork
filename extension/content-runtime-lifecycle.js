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
  let diagnosticSuspended = false;
  let diagnosticSuspendedAt = null;
  let diagnosticLongTaskObserver = null;
  const diagnosticLongTasks = [];
  const callbackStats = new Map();
  const callbackSourceStats = new Map();
  const recentSlowCallbacks = [];
  const recentUserInteractions = [];
  const diagnosticInteractionListeners = [];
  const SLOW_CALLBACK_MS = 20;
  const INTERACTION_TYPES = ['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown', 'input', 'change', 'wheel', 'scroll', 'focusin', 'focusout'];
  const DIAGNOSTIC_CONTROL_MESSAGES = new Set([
    'GPTWORK_DIAGNOSTIC_CONTENT_SUSPEND',
    'GPTWORK_DIAGNOSTIC_PERF_SNAPSHOT',
    'GPTWORK_CONTENT_PREPARE_RELOAD',
  ]);

  function interactionTarget(target) {
    const element = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
    if (!element) return null;
    return {
      tag: String(element.tagName || '').toLowerCase() || null,
      role: element.getAttribute?.('role') || null,
      testId: String(element.getAttribute?.('data-testid') || '').slice(0, 100) || null,
      contentEditable: element.getAttribute?.('contenteditable') === 'true',
      inputType: element.tagName === 'INPUT' ? String(element.getAttribute?.('type') || 'text').slice(0, 40) : null,
    };
  }

  function recordUserInteraction(event) {
    // Never record typed text, key values, form values, or page text. We only need
    // timing + event class + coarse target identity to correlate jank with user input.
    const item = {
      type: event.type,
      atEpochMs: Date.now(),
      atPerformanceMs: Math.round(performance.now() * 10) / 10,
      target: interactionTarget(event.target),
    };
    if (/^pointer|click|dblclick$/.test(event.type)) {
      item.pointerType = String(event.pointerType || 'mouse').slice(0, 20);
      item.button = Number.isFinite(event.button) ? event.button : null;
    } else if (event.type === 'keydown') {
      item.keyClass = event.key?.length === 1 ? 'printable' : 'control';
      item.repeat = event.repeat === true;
    } else if (event.type === 'wheel') {
      item.deltaX = Math.round(Number(event.deltaX) || 0);
      item.deltaY = Math.round(Number(event.deltaY) || 0);
    }
    recentUserInteractions.push(item);
    if (recentUserInteractions.length > 80) recentUserInteractions.splice(0, recentUserInteractions.length - 80);
  }

  function installInteractionDiagnostics() {
    if (typeof original.addEventListener !== 'function') return;
    for (const type of INTERACTION_TYPES) {
      const options = type === 'scroll' || type === 'wheel' ? { capture: true, passive: true } : { capture: true, passive: true };
      try {
        original.addEventListener.call(document, type, recordUserInteraction, options);
        diagnosticInteractionListeners.push({ target: document, type, options });
      } catch {}
    }
    for (const type of ['resize', 'focus', 'blur']) {
      const options = { capture: true, passive: true };
      try {
        original.addEventListener.call(window, type, recordUserInteraction, options);
        diagnosticInteractionListeners.push({ target: window, type, options });
      } catch {}
    }
    try {
      original.addEventListener.call(document, 'visibilitychange', recordUserInteraction, { capture: true, passive: true });
      diagnosticInteractionListeners.push({ target: document, type: 'visibilitychange', options: { capture: true, passive: true } });
    } catch {}
  }

  function removeInteractionDiagnostics() {
    if (typeof original.removeEventListener !== 'function') return;
    for (const record of diagnosticInteractionListeners) {
      try { original.removeEventListener.call(record.target, record.type, recordUserInteraction, record.options); } catch {}
    }
    diagnosticInteractionListeners.length = 0;
  }

  function callbackSource(kind) {
    try {
      const stack = String(new Error('GPTWork callback source').stack || '').split('\n');
      const frame = stack.find((line) =>
        /chrome-extension:\/\//.test(line)
        && !/content-runtime-lifecycle\.js/.test(line)
      );
      return String(frame || stack[2] || kind || 'unknown')
        .trim()
        .replace(/^at\s+/, '')
        .slice(0, 240);
    } catch {
      return String(kind || 'unknown');
    }
  }

  function measureCallback(kind, callback, args, source = kind) {
    if (diagnosticSuspended) return undefined;
    const startedAt = performance.now();
    try {
      return callback(...args);
    } finally {
      const endedAt = performance.now();
      const elapsed = Math.max(0, endedAt - startedAt);
      const current = callbackStats.get(kind) || { count: 0, totalMs: 0, maxMs: 0 };
      current.count += 1;
      current.totalMs += elapsed;
      current.maxMs = Math.max(current.maxMs, elapsed);
      callbackStats.set(kind, current);

      const sourceKey = `${kind}:${source || 'unknown'}`;
      const sourceCurrent = callbackSourceStats.get(sourceKey) || {
        kind,
        source: String(source || 'unknown').slice(0, 240),
        count: 0,
        totalMs: 0,
        maxMs: 0,
      };
      sourceCurrent.count += 1;
      sourceCurrent.totalMs += elapsed;
      sourceCurrent.maxMs = Math.max(sourceCurrent.maxMs, elapsed);
      callbackSourceStats.set(sourceKey, sourceCurrent);

      if (elapsed >= SLOW_CALLBACK_MS) {
        recentSlowCallbacks.push({
          kind,
          source: sourceCurrent.source,
          durationMs: Math.round(elapsed * 10) / 10,
          startedAt: Math.round(startedAt * 10) / 10,
          endedAt: Math.round(endedAt * 10) / 10,
        });
        if (recentSlowCallbacks.length > 24) recentSlowCallbacks.splice(0, recentSlowCallbacks.length - 24);
      }
    }
  }

  function setDiagnosticSuspended(suspended, reason = 'diagnostic') {
    diagnosticSuspended = suspended === true;
    diagnosticSuspendedAt = diagnosticSuspended ? new Date().toISOString() : null;
    return {
      suspended: diagnosticSuspended,
      changedAt: new Date().toISOString(),
      reason: String(reason || 'diagnostic'),
    };
  }

  function installDiagnosticLongTaskObserver() {
    if (!original.PerformanceObserver) return;
    try {
      diagnosticLongTaskObserver = new original.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const duration = Math.max(0, Number(entry.duration) || 0);
          diagnosticLongTasks.push({
            atEpochMs: Date.now(),
            startedAt: Math.round((Number(entry.startTime) || 0) * 10) / 10,
            durationMs: Math.round(duration * 10) / 10,
          });
        }
        if (diagnosticLongTasks.length > 48) {
          diagnosticLongTasks.splice(0, diagnosticLongTasks.length - 48);
        }
      });
      diagnosticLongTaskObserver.observe({ type: 'longtask', buffered: false });
    } catch {
      diagnosticLongTaskObserver = null;
    }
  }

  function diagnosticsSnapshot({ resetCallbacks = false, resetDiagnosticLongTasks = false } = {}) {
    const callbacks = {};
    for (const [kind, value] of callbackStats) {
      callbacks[kind] = {
        count: value.count,
        totalMs: Math.round(value.totalMs * 10) / 10,
        maxMs: Math.round(value.maxMs * 10) / 10,
      };
    }
    const callbackSources = [...callbackSourceStats.values()]
      .sort((a, b) => (b.maxMs - a.maxMs) || (b.totalMs - a.totalMs))
      .slice(0, 16)
      .map((value) => ({
        kind: value.kind,
        source: value.source,
        count: value.count,
        totalMs: Math.round(value.totalMs * 10) / 10,
        maxMs: Math.round(value.maxMs * 10) / 10,
      }));
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
      callbackSources,
      recentSlowCallbacks: recentSlowCallbacks.slice(-12),
      recentUserInteractions: recentUserInteractions.slice(-40),
      diagnosticSuspended,
      diagnosticSuspendedAt,
      diagnosticLongTaskCount: diagnosticLongTasks.length,
      diagnosticMaxLongTaskMs: diagnosticLongTasks.length
        ? Math.max(...diagnosticLongTasks.map((item) => Number(item.durationMs) || 0))
        : 0,
      diagnosticLongTasks: diagnosticLongTasks.slice(-24),
    };
    if (resetCallbacks) {
      callbackStats.clear();
      callbackSourceStats.clear();
      recentSlowCallbacks.length = 0;
      recentUserInteractions.length = 0;
    }
    if (resetDiagnosticLongTasks) diagnosticLongTasks.length = 0;
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
    if (diagnosticLongTaskObserver) {
      try { diagnosticLongTaskObserver.disconnect(); } catch {}
      diagnosticLongTaskObserver = null;
    }
    diagnosticLongTasks.length = 0;
    removeInteractionDiagnostics();
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
    const source = typeof callback === 'function' ? callbackSource('timeout') : 'string-callback';
    const wrapped = typeof callback === 'function'
      ? (...callbackArgs) => {
        timeouts.delete(id);
        if (!checkAlive('timeout_context_invalidated')) return undefined;
        return measureCallback('timeout', callback, callbackArgs, source);
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
    const source = typeof callback === 'function' ? callbackSource('interval') : 'string-callback';
    const wrapped = typeof callback === 'function'
      ? (...callbackArgs) => {
        if (!checkAlive('interval_context_invalidated')) return undefined;
        return measureCallback('interval', callback, callbackArgs, source);
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
      const source = callbackSource('animationFrame');
      id = original.requestAnimationFrame((timestamp) => {
        animationFrames.delete(id);
        if (!checkAlive('animation_frame_context_invalidated')) return;
        measureCallback('animationFrame', callback, [timestamp], source);
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
      const source = callbackSource('mutationObserver');
      super((records, observer) => {
        if (!checkAlive('mutation_context_invalidated')) return;
        measureCallback('mutationObserver', callback, [records, observer], source);
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
        const source = callbackSource('performanceObserver');
        super((entries, observer) => {
          if (!checkAlive('performance_observer_context_invalidated')) return;
          measureCallback('performanceObserver', callback, [entries, observer], source);
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
        const source = callbackSource('resizeObserver');
        super((entries, observer) => {
          if (!checkAlive('resize_observer_context_invalidated')) return;
          measureCallback('resizeObserver', callback, [entries, observer], source);
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
    const source = callbackSource(`domEvent:${type}`);
    if (typeof listener === 'function') {
      wrapped = function measuredDomEventListener(...args) {
        return measureCallback('domEvent', listener.bind(this), args, source);
      };
    } else if (listener && typeof listener.handleEvent === 'function') {
      wrapped = {
        handleEvent(...args) {
          return measureCallback('domEvent', listener.handleEvent.bind(listener), args, source);
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
      const existing = [...chromeEventListeners].find((record) => record.event === event && record.listener === listener);
      if (existing) return add.call(event, existing.wrapped || listener);
      const source = callbackSource('chromeEvent');
      const isRuntimeMessage = event === globalThis.chrome?.runtime?.onMessage;
      const wrapped = function measuredChromeEventListener(...args) {
        const messageType = isRuntimeMessage ? String(args?.[0]?.type || '') : '';
        if (diagnosticSuspended && isRuntimeMessage && DIAGNOSTIC_CONTROL_MESSAGES.has(messageType)) {
          return listener(...args);
        }
        return measureCallback('chromeEvent', listener, args, source);
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

  installInteractionDiagnostics();
  installDiagnosticLongTaskObserver();

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
    setDiagnosticSuspended,
    isDiagnosticSuspended: () => diagnosticSuspended,
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