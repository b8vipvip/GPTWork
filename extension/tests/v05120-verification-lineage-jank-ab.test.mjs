import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const content = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const monitor = fs.readFileSync(new URL('../network-monitor.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const control = fs.readFileSync(new URL('../jank-control.js', import.meta.url), 'utf8');
const collector = fs.readFileSync(new URL('../../tools/windows/GPTWork-Jank-Diagnostic.ps1', import.meta.url), 'utf8');

test('mode-B discovery never promotes combined composer model/reasoning text into a fake model', () => {
  assert.match(content, /modern\.pickerMode !== 'B'.*current\?\.model/s);
  assert.match(content, /advanced picker rows are the only UI catalog authority in mode B/i);
});

test('conversation history metadata cannot join served-model stream lineage', () => {
  assert.match(monitor, /function isConversationMetadataEndpoint/);
  assert.match(monitor, /path === '\/backend-api\/conversations'/);
  assert.match(monitor, /isConversationMetadataEndpoint\(request\.url\)\) return/);
});

test('verified downstream packets are not repeatedly re-evaluated unless evidence contradicts', () => {
  assert.match(background, /const priorVerified = state\.lastVerification\?\.verdict === 'verified'/);
  assert.match(background, /if \(priorVerified && !addsContradiction\) return/);
});

test('Windows jank collector performs causal A-B isolation and restores normal mode', () => {
  for (const phase of ['baseline_normal', 'cdp_off', 'normal_recheck', 'content_off', 'high_level_off']) {
    assert.ok(collector.includes(phase), `missing phase ${phase}`);
  }
  assert.match(collector, /phase-cpu-summary\.csv/);
  assert.match(collector, /Set-GPTWorkIsolation 'restore_normal' 'normal'/);
  assert.match(control, /GPTWORK_SET_JANK_ISOLATION/);
  assert.match(control, /windows-jank-ab/);
});
