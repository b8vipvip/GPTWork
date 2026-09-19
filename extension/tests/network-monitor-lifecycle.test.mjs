import assert from 'node:assert/strict';
import test from 'node:test';

function delayedCallback(callback, delay = 8) {
  setTimeout(() => callback?.(), delay);
}

test('network monitor serializes debugger attach and detach per tab', async () => {
  let attachCalls = 0;
  let detachCalls = 0;
  let fetchEnableCalls = 0;
  const inputEvents = [];

  globalThis.chrome = {
    runtime: { lastError: null },
    debugger: {
      attach(_target, _version, callback) {
        attachCalls += 1;
        delayedCallback(callback);
      },
      detach(_target, callback) {
        detachCalls += 1;
        delayedCallback(callback);
      },
      sendCommand(_target, command, params, callback) {
        if (command === 'Fetch.enable') fetchEnableCalls += 1;
        if (command === 'Input.dispatchMouseEvent') inputEvents.push(params);
        delayedCallback(callback, 1);
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };

  const { ChatGptNetworkMonitor } = await import(`../network-monitor.js?lifecycle=${Date.now()}`);
  const monitor = new ChatGptNetworkMonitor({
    onStatus() {},
    onRequest() {},
    onEvidence() {},
    onFailure() {},
    onRewrite() {},
    onStreamData() {},
    getLockConfiguration() { return {}; },
  });

  const firstPair = await Promise.all([monitor.attach(17), monitor.attach(17)]);
  assert.deepEqual(firstPair, [true, true]);
  assert.equal(attachCalls, 1, 'concurrent attach calls must share one debugger.attach');
  assert.equal(fetchEnableCalls, 1, 'Fetch.enable must also run only once for the shared attach');
  assert.equal(monitor.isAttached(17), true);

  await Promise.all([monitor.detach(17), monitor.detach(17)]);
  assert.equal(detachCalls, 1, 'concurrent detach calls must share one debugger.detach');
  assert.equal(monitor.isAttached(17), false);

  await monitor.attach(17);
  assert.equal(attachCalls, 2);

  const detachTask = monitor.detach(17);
  const reattachTask = monitor.attach(17);
  await Promise.all([detachTask, reattachTask]);
  assert.equal(detachCalls, 2);
  assert.equal(attachCalls, 3, 'attach requested during detach must run after detach completes');
  assert.equal(monitor.isAttached(17), true);

  await monitor.trustedPointer(17, { action: 'click', x: 120, y: 240 });
  assert.deepEqual(inputEvents.slice(-3).map((event) => event.type), [
    'mouseMoved',
    'mousePressed',
    'mouseReleased',
  ]);
  assert.equal(inputEvents.at(-1).x, 120);
  assert.equal(inputEvents.at(-1).y, 240);
});
