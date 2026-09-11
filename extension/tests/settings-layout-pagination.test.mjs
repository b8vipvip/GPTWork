import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const settingsHtml = await readFile(new URL('../settings-v0521.html', import.meta.url), 'utf8');
const historyOptionsSource = await readFile(new URL('../request-history-options.js', import.meta.url), 'utf8');
const historyCss = await readFile(new URL('../request-history.css', import.meta.url), 'utf8');

test('locked models sits directly after feature gates and update center is the last settings card', () => {
  const featureIndex = settingsHtml.indexOf('id="globalHeading"');
  const modelIndex = settingsHtml.indexOf('id="modelHeading"');
  const reasoningIndex = settingsHtml.indexOf('id="reasoningHeading"');
  const historyIndex = settingsHtml.indexOf('id="requestHistoryHeading"');
  const updateIndex = settingsHtml.indexOf('id="updateHeading"');
  const footerIndex = settingsHtml.indexOf('<footer>');

  assert(featureIndex >= 0);
  assert(modelIndex > featureIndex);
  assert(reasoningIndex > modelIndex);
  assert(historyIndex > reasoningIndex);
  assert(updateIndex > historyIndex);
  assert(footerIndex > updateIndex);
  assert.equal(settingsHtml.lastIndexOf('<section'), settingsHtml.lastIndexOf('<section id="updates"'));
});

test('request history pagination renders eight records per page with previous and next controls', () => {
  assert.match(settingsHtml, /id="requestHistoryPagination"/);
  assert.match(settingsHtml, /id="requestHistoryPrev"/);
  assert.match(settingsHtml, /id="requestHistoryNext"/);
  assert.match(settingsHtml, /id="requestHistoryPageInfo"/);
  assert.match(historyOptionsSource, /const PAGE_SIZE = 8;/);
  assert.match(historyOptionsSource, /currentRecords\.slice\(start, start \+ PAGE_SIZE\)/);
  assert.match(historyOptionsSource, /currentPage \+= 1/);
  assert.match(historyOptionsSource, /currentPage -= 1/);
  assert.match(historyCss, /\.request-history-pagination/);
});
