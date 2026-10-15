import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../content-runtime-lifecycle.js', import.meta.url), 'utf8');

function createHarness() {
  let timer = 0;
  class MockTarget {
    constructor() { this.listeners = []; }
    addEventListener(type, listener, options) {
      if (this instanceof AbortSignal) return EventTarget.prototype.addEventListener.call(this, type, listener, options);
      const capture = typeof options === 'boolean' ? options : options?.capture === true;
      if (!listener || options?.signal?.aborted) return;
      if (this.listeners.some((entry) => entry.type === type && entry.listener === listener && entry.capture === capture)) return;
      this.listeners.push({ type, listener, capture, once: options?.once === true });
      options?.signal?.addEventListener('abort', () => this.removeEventListener(type, listener, capture), { once: true });
    }
    removeEventListener(type, listener, options) {
      if (this instanceof AbortSignal) return EventTarget.prototype.removeEventListener.call(this, type, listener, options);
      const capture = typeof options === 'boolean' ? options : options?.capture === true;
      this.listeners = this.listeners.filter((entry) =>
        entry.type !== type || entry.listener !== listener || entry.capture !== capture);
    }
    emit(type) {
      for (const entry of [...this.listeners]) {
        if (entry.type !== type) continue;
        if (entry.once) this.removeEventListener(type, entry.listener, entry.capture);
        const event = { type, target: this };
        if (typeof entry.listener === 'function') entry.listener.call(this, event);
        else entry.listener.handleEvent(event);
      }
    }
    count(type) { return this.listeners.filter((entry) => entry.type === type).length; }
  }
  const chromeEvent = () => ({ addListener() {}, removeListener() {} });
  const document = new MockTarget();
  document.getElementById = () => null;
  const context = vm.createContext({
    EventTarget: MockTarget, document,
    MutationObserver: class { disconnect() {} },
    PerformanceObserver: class { disconnect() {} },
    ResizeObserver: class { disconnect() {} },
    chrome: { runtime: { id: 'test', onMessage: chromeEvent() }, storage: { onChanged: chromeEvent() } },
    performance, WeakRef,
    setTimeout: () => ++timer, clearTimeout() {},
    setInterval: () => ++timer, clearInterval() {},
    requestAnimationFrame: () => ++timer, cancelAnimationFrame() {},
  });
  context.window = context;
  vm.runInContext(source, context);
  return { MockTarget, lifecycle: context.__GPTWORK_CONTENT_RUNTIME_LIFECYCLE_V1__ };
}

test('large listener sets support fast indexed removal and release every live handler on shutdown', () => {
  const { MockTarget, lifecycle } = createHarness();
  const targets = Array.from({ length: 2500 }, () => new MockTarget());
  const handler = () => {};
  for (const target of targets) target.addEventListener('click', handler);
  assert.equal(lifecycle.diagnosticsSnapshot().live.domEventListeners, 2500);
  for (const target of targets.slice(0, 1500)) target.removeEventListener('click', handler);
  assert.equal(lifecycle.diagnosticsSnapshot().live.domEventListeners, 1000);
  lifecycle.shutdown('test');
  assert.equal(targets.reduce((sum, target) => sum + target.count('click'), 0), 0);
});

test('capture, duplicate registration, once, object listeners and signal abort preserve browser semantics', () => {
  const { MockTarget, lifecycle } = createHarness();
  const target = new MockTarget();
  let count = 0;
  const listener = { handleEvent() { count += 1; } };
  target.addEventListener('click', listener);
  target.addEventListener('click', listener, false);
  target.addEventListener('click', listener, { capture: true });
  assert.equal(target.count('click'), 2);
  target.emit('click');
  assert.equal(count, 2);
  target.removeEventListener('click', listener);
  target.removeEventListener('click', listener, { capture: true });
  assert.equal(lifecycle.diagnosticsSnapshot().live.domEventListeners, 0);

  target.addEventListener('click', () => { count += 1; }, { once: true });
  target.emit('click');
  target.emit('click');
  assert.equal(count, 3);
  assert.equal(lifecycle.diagnosticsSnapshot().live.domEventListeners, 0);

  const controller = new AbortController();
  target.addEventListener('click', listener, { signal: controller.signal });
  assert.equal(lifecycle.diagnosticsSnapshot().live.domEventListeners, 1);
  controller.abort();
  assert.equal(target.count('click'), 0);
  assert.equal(lifecycle.diagnosticsSnapshot().live.domEventListeners, 0);
  target.addEventListener('click', listener, { signal: controller.signal });
  assert.equal(lifecycle.diagnosticsSnapshot().live.domEventListeners, 0);
  lifecycle.shutdown('test');
});

test('live registry avoids strong DOM references, linear Set scans and default stack sampling', () => {
  assert.match(source, /eventListenerIndex = new WeakMap\(\)/);
  assert.match(source, /targetRef, listenerRef, wrappedRef: new WeakRef\(wrapped\)/);
  assert.match(source, /diagnosticCaptureActive \? callbackSource/);
  assert.doesNotMatch(source, /\[\.\.\.eventListeners\]\.find/);
  assert.doesNotMatch(source, /eventListeners\.add\(\{ target: this/);
});
