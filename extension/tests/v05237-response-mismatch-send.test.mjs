import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { evaluateGuard } from '../guard.js';
import { DEFAULT_POLICY, DEFAULT_SETTINGS } from '../policy.js';

const content = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const begin = content.indexOf('  function handlePotentialSend(event) {');
const end = content.indexOf('  function matchesAny(element, selectors) {', begin);
assert.ok(begin >= 0 && end > begin, 'the actual ChatGPT composer send handler must exist');

for (const strictMode of [true, false]) {
  test(`a confirmed response-model mismatch does not cancel click, Enter or submit (strictMode=${strictMode})`, async () => {
    const guard = evaluateGuard({
      state: {
        phase: 'mismatch',
        monitor: { attached: true },
        core: { connected: true },
        pageObservation: { model: 'gpt-5.5', reasoning: 'high' },
        lastRequest: { capturedAt: '2026-10-16T11:00:00Z' },
        lastVerification: {
          model: 'gpt-5.5',
          verdict: 'mismatch',
          reason: 'model_not_allowed',
          reasons: ['model_not_allowed'],
          verifiedAt: '2026-10-16T11:00:05Z',
        },
      },
      policy: { ...DEFAULT_POLICY, strictMode },
      settings: { ...DEFAULT_SETTINGS, enabled: true, networkVerificationEnabled: true },
    });
    assert.equal(guard.canSend, true);
    assert.equal(guard.allowKind, 'warning');
    assert.equal(guard.reason, 'model_not_allowed');

    for (const type of ['click', 'keydown', 'submit']) {
      const messages = [];
      let started = 0;
      let cancelled = 0;
      const ctx = vm.createContext({
        cachedState: { guard },
        cachedSettings: { enabled: true, networkVerificationEnabled: true },
        sendConsumedAt: 0,
        lastRuntimeContactAt: Date.now(),
        BLOCKING_GUARD_MAX_AGE_MS: 30_000,
        runtimeContextAvailable: () => true,
        failOpenStaleRuntime: () => { throw new Error('unexpected runtime fallback'); },
        showNotice: () => { throw new Error('unexpected blocked-send notice'); },
        locallyMarkSendStarted: () => { started++; },
        sendMessage: (message) => { messages.push(message); return Promise.resolve(); },
        Date,
      });
      vm.runInContext(content.slice(begin, end) + '\nglobalThis.send = handlePotentialSend;', ctx);
      const event = {
        type,
        preventDefault: () => { cancelled++; },
        stopPropagation: () => { cancelled++; },
        stopImmediatePropagation: () => { cancelled++; },
      };
      assert.equal(ctx.send(event), true);
      assert.equal(cancelled, 0);
      assert.equal(started, 1);
      assert.deepEqual(messages.map((message) => message.type), ['GPTLOCK_SEND_STARTED']);
    }
  });
}
