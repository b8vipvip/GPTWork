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

test('Windows installer stages and atomically commits Core with the extension generation', () => {
  assert.match(installer, /DestDir: "\{app\}\\bin\.next"/);
  assert.doesNotMatch(installer, /DestDir: "\{app\}\\bin"; Flags: ignoreversion/);
  assert.match(installer, /function RecoverInterruptedCoreSwap\(\): Boolean;/);
  assert.match(installer, /function ValidateStagedCorePayload\(\): Boolean;/);
  assert.match(installer, /function SwapCorePayload\(\): Boolean;/);
  assert.match(installer, /procedure RollbackCorePayloadSwap;/);
  assert.match(installer, /procedure FinishCorePayloadSwap;/);
  assert.match(installer, /bin\.previous/);
  assert.match(installer, /gptwork-core\.exe/);
  assert.match(installer, /--version/);
  assert.match(installer, /\[regex\]::Escape\(''\{#MyAppVersion\}''\)/);

  const postInstall = installer.match(/procedure CurStepChanged[\s\S]*?procedure DeinitializeSetup/)?.[0] ?? '';
  assert.ok(
    postInstall.indexOf('ValidateStagedCorePayload') < postInstall.indexOf('SwapCorePayload'),
    'staged Core must be version-validated before it becomes live',
  );
  assert.ok(
    postInstall.indexOf('SwapCorePayload') < postInstall.indexOf('SwapExtensionPayload'),
    'Core must become live before the matching extension generation is exposed',
  );
  assert.match(postInstall, /RollbackCorePayloadSwap/);
  assert.match(postInstall, /FinishCorePayloadSwap/);

  const deinitialize = installer.slice(installer.indexOf('procedure DeinitializeSetup'));
  assert.match(deinitialize, /RollbackExtensionSwap/);
  assert.match(deinitialize, /RollbackCorePayloadSwap/);
});


test('automatic update keeps extension reload under one background authority', () => {
  const updaterRust = fs.readFileSync(path.resolve(here, '../../native-core/src/updater.rs'), 'utf8');
  const repair = fs.readFileSync(path.resolve(here, '../../packaging/windows/Repair-GPTWork.ps1'), 'utf8');

  assert.match(updaterRust, /\/GPTWORKAUTOUPDATE=1/);
  assert.match(installer, /function IsBackgroundAutoUpdate\(\): Boolean;/);
  assert.match(installer, /function RepairExtensionReloadArgument\(Param: String\): String;/);
  assert.match(installer, /-SkipExtensionReload/);
  assert.match(repair, /\[switch\]\$SkipExtensionReload/);
  assert.match(repair, /if \(-not \$SkipExtensionReload\)/);
  assert.match(repair, /扩展重载由后台 updater 单独负责/);
});
