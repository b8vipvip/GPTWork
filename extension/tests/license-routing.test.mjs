import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const policy = new URL('../policy.js', import.meta.url);
const background = new URL('../background.js', import.meta.url);

test('account entitlement is the only product authorization route', async () => {
  const [policySource, backgroundSource] = await Promise.all([
    readFile(policy, 'utf8'),
    readFile(background, 'utf8'),
  ]);

  for (const source of [policySource, backgroundSource]) {
    assert.doesNotMatch(source, /GPTLOCK-LICENSE|GPTLOCK_LICENSE/);
    assert.doesNotMatch(source, /LICENSE_UI_STALE/);
    assert.doesNotMatch(source, /gptlockLicense|license heartbeat|License required/i);
  }
  assert.match(backgroundSource, /GPTLOCK_ACCOUNT_LOGIN/);
  assert.match(backgroundSource, /GPTLOCK_ACCOUNT_LOGOUT/);
  assert.match(backgroundSource, /GPTLOCK_ACCOUNT_REFRESH/);
  assert.match(backgroundSource, /accountAllowsState/);
  assert.doesNotMatch(backgroundSource, /GPTLOCK_SET_ENABLED/);
});
