import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const eventStart = source.indexOf(
  "logRuntime(finalOutcome === 'verified' ? 'info' : 'warn', 'discovery', 'auto_verify_completed'",
);
assert.ok(eventStart > 0, 'auto_verify_completed diagnostic event missing');
const eventEnd = source.indexOf('\n    });', eventStart);
assert.ok(eventEnd > eventStart, 'auto_verify_completed diagnostic event is not closed');
const event = source.slice(eventStart, eventEnd);

test('auto verification summary records source tab, picker mode, and exact request correlation', () => {
  assert.match(event, /sourceTabId/);
  assert.match(event, /verificationSurface/);
  assert.match(event, /pickerMode: item\.pickerMode/);
  assert.match(event, /requestId: item\.requestId/);
  assert.match(event, /responseRequestId: item\.responseRequestId/);
});

test('auto verification summary records raw served-model evidence and explicit failure reasons', () => {
  assert.match(event, /rawRequestModel: item\.rawRequestModel/);
  assert.match(event, /rawResponseModel: item\.rawResponseModel/);
  assert.match(event, /responseModelField: item\.responseModelField/);
  assert.match(event, /responseModelCandidatePaths/);
  assert.match(event, /responseMetadataConflict/);
  assert.match(event, /responseIssue: item\.responseIssue/);
  assert.match(event, /responseNetworkError/);
  assert.match(event, /responseBodyError/);
  assert.match(event, /responseTerminalEvent/);
  assert.match(event, /responseStreamCaptureOverflowed/);
});

test('summary logs metadata only and never embeds raw response bodies or stream frames', () => {
  assert.doesNotMatch(event, /rawResponseBody|rawSse|rawFrame|responseBody:\s*item\./);
});

