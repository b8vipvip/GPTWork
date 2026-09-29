import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');

test('v0.5.152 composer witness follows the randomized prompt when semantic marker is absent', () => {
  const probeText = '将 45 分钟换算成秒，只输出数字。';
  const probeMarker = 'GPTWork 模型验证';
  const composerWitness = probeText.includes(probeMarker) ? probeMarker : probeText.slice(0, 120);
  assert.equal(composerWitness, probeText);
  assert.equal(probeText.includes(composerWitness), true);
  assert.equal(probeText.includes(probeMarker), false);

  const start = content.indexOf('async function autoSendProbe(options = {})');
  const end = content.indexOf('async function resolveModelNamesWithChatGpt', start);
  assert.ok(start >= 0 && end > start);
  const block = content.slice(start, end);
  assert.match(block, /const composerWitness = probeText\.includes\(probeMarker\) \? probeMarker : probeText\.slice\(0, 120\)/);
});
