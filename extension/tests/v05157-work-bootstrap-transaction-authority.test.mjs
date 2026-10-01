import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const monitor = await readFile(new URL('../network-monitor.js', import.meta.url), 'utf8');

test('network Work verification keeps verificationTransactions as the terminal request authority', () => {
  const start = background.indexOf('async function verifyAccountCatalogModels');
  const end = background.indexOf('function modelVerificationHistoryRecord', start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);
  assert.match(block, /selectorKey: '__work_transport__'/);
  assert.match(block, /verificationTransactions\.set\(Number\(tabId\), \{/);
  assert.doesNotMatch(block, /sendVerificationReasoningProbe\(tabId, 'work-mode-bootstrap'/);
  assert.doesNotMatch(block, /beginWorkBootstrapTransaction\(tabId, 'post-sol-work-activation'\)/);
  assert.match(monitor, /authorityKind: 'verification-transaction'/);
  assert.match(monitor, /forceModel: model/);
});

test('network Work phase does not require Picker B to enter', () => {
  assert.match(background, /reason: 'network_work_catalog_seeded'/);
  assert.match(background, /pickerMode: null/);
  assert.match(background, /entered: true/);
});
