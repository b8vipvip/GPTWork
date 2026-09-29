import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');

test('v0.5.153 retries only the already-owned verification row through the synthetic page path', () => {
  const start = content.indexOf('async function modelPickerPointer');
  const end = content.indexOf('async function trustedPointer', start);
  assert.ok(start >= 0 && end > start);
  const block = content.slice(start, end);
  assert.match(block, /source === 'verification-model-row'/);
  assert.match(block, /element\?\.isConnected/);
  assert.match(block, /visible\(element\)/);
  assert.match(block, /verification_exact_row_synthetic_fallback/);
  assert.match(block, /dispatchSyntheticPointer\(element, action\)/);
});

test('v0.5.153 never network-defers a model-changing Picker A turn', () => {
  const start = content.indexOf('async function selectModelForVerification');
  const end = content.indexOf('async function chooseExact', start);
  assert.ok(start >= 0 && end > start);
  const block = content.slice(start, end);
  const matches = block.match(/observation\.model === desired/g) || [];
  assert.ok(matches.length >= 2, 'both pointer-reject and post-click defer gates require page confirmation');
  assert.match(block, /networkDeferredAfterPointerReject/);
  assert.match(block, /const networkDeferred = !confirmed/);
});
