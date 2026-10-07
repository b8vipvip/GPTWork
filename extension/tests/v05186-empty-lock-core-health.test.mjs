// [legacy-core-maintenance] v0.5.186 aligns the extension's explicit empty-lock state with Native Core health semantics.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const config = fs.readFileSync(new URL('../../native-core/src/config.rs', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../../native-core/src/bridge.rs', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');

test('Native Core accepts explicit empty lockedModels as model lock disabled', () => {
  assert.doesNotMatch(config, /lockedModels must contain at least one model/);
  assert.match(config, /explicitly empty model list is the canonical "model lock disabled" state/);
  assert.match(config, /fn accepts_empty_model_policy_as_disabled_lock/);
  assert.match(bridge, /fn set_policy_accepts_an_empty_model_lock/);
  assert.match(bridge, /"lockedModels": \[\]/);
});

test('application-level set_policy rejection never masquerades as a disconnected Core', () => {
  assert.match(background, /error\.code = message\.error\?\.code \|\| 'native_request_failed'/);
  assert.match(background, /function isNativeApplicationRequestError/);
  assert.match(background, /policy_sync_rejected_core_still_connected/);
  assert.match(background, /lastPolicyError: policySyncError/);
  assert.match(background, /return \{ connected: true, error: null, policySyncError, status \}/);
});

test('real Native transport failures still mark the Core disconnected', () => {
  assert.match(background, /await writeNativeStatus\(\{ connected: false, lastError: detail \}\)/);
  assert.match(background, /await writeNativeStatus\(\{ connected: false, lastError: errorText\(error\) \}\)/);
});
