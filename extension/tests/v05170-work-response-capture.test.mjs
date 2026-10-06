import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('normal user sends refresh page selection before deriving the request policy', async () => {
  const background = await read('background.js');
  const start = background.indexOf("case 'GPTLOCK_SEND_STARTED'");
  const end = background.indexOf("case 'GPTLOCK_ARM_PROBE'", start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);
  const collect = block.indexOf('await collectPageObservation(sender.tab.id, state)');
  const guard = block.indexOf('const guard = guardFor(state)');
  assert.ok(collect >= 0 && guard > collect, 'page observation must refresh before guard/request policy is evaluated');
  assert.match(block, /pre_send_page_observation_unavailable/);
});

test('normal user sends arm Network response capture before ChatGPT request dispatch', async () => {
  const background = await read('background.js');
  const start = background.indexOf("case 'GPTLOCK_SEND_STARTED'");
  const end = background.indexOf("case 'GPTLOCK_ARM_PROBE'", start);
  const block = background.slice(start, end);
  assert.match(block, /networkMonitor\.enableResponseCapture\(sender\.tab\.id\)/);
  assert.match(block, /normal_response_capture_armed/);
  assert.match(block, /responseCaptureTabs: networkMonitor\.responseCaptureCount\(\)/);
});

test('Work default model remains the real minimum request model when page evidence is unavailable', async () => {
  const runtime = await read('tab-feature-runtime.js');
  const start = runtime.indexOf('export function requestPolicyForTabSync');
  const end = runtime.indexOf('export function effectivePolicyForTabSync', start);
  const resolver = runtime.slice(start, end);
  assert.match(resolver, /if \(workFeatureEnabled && feature\.workModeEnabled\)/);
  assert.match(resolver, /const floor = normalizeConcreteModelId\(basePolicy\.workDefaultModel\) \|\| DEFAULT_WORK_MODEL/);
  assert.match(resolver, /lockedModels = \[selected && isAtLeastWorkFloor\(selected, floor\) \? selected : floor\]/);
});
