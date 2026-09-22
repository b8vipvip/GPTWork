import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const content = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const monitor = fs.readFileSync(new URL('../network-monitor.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const control = fs.readFileSync(new URL('../jank-control.js', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../../tools/windows/GPTWork-Jank-Diagnostic.ps1', import.meta.url), 'utf8');

test('v0.5.121 mode-B discovery trusts model rows instead of combined trigger text', () => {
  assert.match(content, /modern\.pickerMode !== 'B'.*current\?\.model/s);
  assert.match(content, /fake "gpt-5\.6"/);
});

test('v0.5.121 served-model lineage excludes conversation history metadata', () => {
  assert.match(monitor, /function isConversationMetadataEndpoint/);
  assert.match(monitor, /path === '\/backend-api\/conversations'/);
  assert.match(monitor, /isConversationMetadataEndpoint\(request\.url\)\) return/);
});

test('v0.5.121 preserves terminal verification across duplicate downstream packets', () => {
  assert.match(background, /const priorVerified = state\.lastVerification\?\.verdict === 'verified'/);
  assert.match(background, /if \(priorVerified && !addsContradiction\) return/);
});

test('v0.5.121 jank diagnostic runs causal A-B phases without restoring high-cost input polling', () => {
  for (const phase of ['baseline_normal', 'cdp_off', 'normal_recheck', 'content_off', 'high_level_off']) {
    assert.ok(script.includes(phase), `missing phase ${phase}`);
  }
  assert.match(script, /phase-cpu-summary\.csv/);
  assert.match(script, /phase-thread-summary\.csv/);
  assert.match(script, /Set-GPTWorkIsolation 'restore_normal' 'normal'/);
  assert.match(control, /GPTWORK_SET_JANK_ISOLATION/);
  assert.doesNotMatch(script, /foreach\(\$vk in 8\.\.254\)/);
});
