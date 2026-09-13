import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const installerPath = path.resolve(here, '../../packaging/windows/GPTWork.iss');
const installer = fs.readFileSync(installerPath, 'utf8');

test('Windows installer pauses Native Messaging before replacing a running core', () => {
  const prepare = installer.match(/function PrepareToInstall[\s\S]*?procedure WriteNativeManifest/)?.[0] ?? '';

  assert.match(prepare, /PauseNativeMessaging/);
  assert.match(prepare, /StopInstalledCoreProcesses/);
  assert.ok(
    prepare.indexOf('PauseNativeMessaging') < prepare.indexOf('StopInstalledCoreProcesses'),
    'Native Messaging must be paused before the running native host is killed',
  );

  assert.match(installer, /\.install-backup/);
  assert.match(installer, /TotalMilliseconds -ge 1000/);
  assert.match(installer, /RestorePausedNativeMessaging/);
  assert.match(installer, /procedure DeinitializeSetup/);
  assert.match(installer, /FinishNativeMessagingPause/);
});

test('successful install recreates manifests only after the replacement payload is installed', () => {
  const postInstall = installer.match(/procedure CurStepChanged[\s\S]*?procedure DeinitializeSetup/)?.[0] ?? '';

  assert.match(postInstall, /ssPostInstall/);
  assert.match(postInstall, /WriteNativeManifest/);
  assert.match(postInstall, /FinishNativeMessagingPause/);
  assert.match(postInstall, /InstallCompleted := True/);
});
