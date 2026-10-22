import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { DEFAULT_SETTINGS, normalizeSettings } from '../policy.js';

const content = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');

function handler(type, nextType) {
  const start = background.indexOf("case '" + type + "': {");
  const end = background.indexOf("case '" + nextType + "': {", start + 1);
  assert.ok(start >= 0 && end > start, 'missing handler: ' + type);
  return background.slice(start, end);
}

test('legacy automatic page model alignment cannot be re-enabled by account or server preferences', () => {
  assert.equal(DEFAULT_SETTINGS.autoAlignSelection, false);
  assert.equal(normalizeSettings({ autoAlignSelection: true }).autoAlignSelection, false);
  assert.equal(normalizeSettings({ autoAlignSelection: false }).autoAlignSelection, false);
  assert.match(background, /autoAlignSelection:\s*false,\s*\/\/ Never revive legacy page alignment/);
});

test('background CDP pointer and keyboard paths require discovery or explicit scoped debug', () => {
  const commands = [
    ['GPTLOCK_TRUSTED_POINTER_PREPARE', 'GPTLOCK_TRUSTED_KEY'],
    ['GPTLOCK_TRUSTED_KEY', 'GPTLOCK_TRUSTED_POINTER'],
    ['GPTLOCK_TRUSTED_POINTER', 'GPTLOCK_PAGE_OBSERVATION'],
  ];
  for (const [command, next] of commands) {
    const code = handler(command, next);
    const check = code.indexOf('tabStates.get(sender.tab.id)?.autoVerification?.running !== true');
    const action = code.indexOf(command === 'GPTLOCK_TRUSTED_POINTER_PREPARE'
      ? 'networkMonitor.attach(sender.tab.id)'
      : command === 'GPTLOCK_TRUSTED_KEY'
        ? 'networkMonitor.trustedKey(sender.tab.id, key)'
        : 'networkMonitor.trustedPointer(sender.tab.id, { action, x, y })');
    assert.ok(check >= 0 && action > check, command + ' must check before CDP');
    assert.match(code, /discovery_or_explicit_debug_action_not_authorized/);
    assert.match(code, /debugAstraProbes\\.get\\(sender\\.tab\\.id\\)\\?\\.phase !== 'dispatching'/);
  }
});

test('content runtime blocks model selection outside discovery and scopes debug to send', () => {
  for (const sig of [
    "function dispatchSyntheticPointer(element, action = 'click') {",
    "async function modelPickerPointer(element, action = 'click', source = 'model-picker') {",
  ]) {
    const at = content.indexOf(sig);
    assert.ok(at >= 0, sig);
    assert.match(content.slice(at, at + 400), /if \(!autoVerificationRunning\) return false;/);
  }
  assert.match(content, /if \(!autoVerificationRunning\) return false;\s*\/\/ Synthetic fallback/);
});

test('passive selection snapshots remain enabled in normal Chat without opening a picker', () => {
  assert.match(content, /GPTLOCK_PAGE_OBSERVATION/);
  assert.match(content, /function collectObservation\(/);
  assert.doesNotMatch(content, /scheduleAlign\(\)/);
  assert.match(content, /cachedState\?\.autoVerification\?\.running === true/);
});
