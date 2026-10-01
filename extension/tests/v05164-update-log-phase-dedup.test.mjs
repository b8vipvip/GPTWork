import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const updateManager = await readFile(new URL('../update-manager.js', import.meta.url), 'utf8');

test('update start diagnostics are emitted only when the persisted phase changes', () => {
  const body = updateManager.match(/export function bindUpdateStatusLogging\([^]*?\n\}/)?.[0] || '';

  assert.match(body, /const previousPhase = change\.oldValue\?\.phase \?\? null;/);
  assert.match(body, /const nextPhase = status\?\.phase \?\? null;/);
  assert.match(body, /if \(previousPhase === nextPhase\) return;/);
  assert.match(body, /const event = updateStatusEventName\(nextPhase\);/);
  assert.match(body, /logUpdate\(nextPhase === 'error' \? 'error' : 'info'/);
});

test('progress-only storage mutations cannot masquerade as new download or install starts', () => {
  const body = updateManager.match(/export function bindUpdateStatusLogging\([^]*?\n\}/)?.[0] || '';
  const phaseGuard = body.indexOf('if (previousPhase === nextPhase) return;');
  const eventLookup = body.indexOf('const event = updateStatusEventName(nextPhase);');
  const eventLog = body.indexOf("logUpdate(nextPhase === 'error' ? 'error' : 'info'");

  assert.ok(phaseGuard >= 0);
  assert.ok(eventLookup > phaseGuard);
  assert.ok(eventLog > eventLookup);
  assert.doesNotMatch(body, /percent/);
});
