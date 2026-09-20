#define MyAppName "GPTWork"
#ifndef MyAppVersion
  #define MyAppVersion "0.5.95"
#endif
#ifndef PrivateEnginePath
  #define PrivateEnginePath ""
#endif
#ifndef ChromeStoreExtensionId
  #define ChromeStoreExtensionId ""
#endif
#ifndef EdgeStoreExtensionId
  #define EdgeStoreExtensionId ""
#endif
#define MyAppPublisher "GPTWork Maintainers"
#define MyAppURL "https://github.com/b8vipvip/GPTWork"
#define ExtensionId "bhchcpeodphgjfjoookncemnamdbfcof"

[Setup]
AppId={{9A784B09-CB5C-4A05-8A29-49F36DA0D6CA}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\GPTWork
DefaultGroupName=GPTWork
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\windows
OutputBaseFilename=GPTWorkSetup-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=GPTWork
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName=GPTWork
VersionInfoDescription=GPTWork Installer

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[InstallDelete]
; Never recursively delete the live extension directory while Chrome/Edge may still be
; executing that generation. New files are copied to extension.next and swapped only
; after the complete payload exists. These two directories are transaction scratch space.
Type: filesandordirs; Name: "{app}\extension.next"
Type: filesandordirs; Name: "{app}\extension.previous"
Type: files; Name: "{app}\bin\gptlock-core.exe"
Type: files; Name: "{app}\bin\gptlock-engine.exe"
Type: files; Name: "{app}\tools\Update-GPTLock.ps1"
Type: files; Name: "{app}\tools\Repair-GPTLock.ps1"

[Files]
Source: "..\..\native-core\target\release\gptwork-core.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
#if PrivateEnginePath != ""
Source: "{#PrivateEnginePath}"; DestDir: "{app}\bin"; DestName: "gptwork-engine.exe"; Flags: ignoreversion
#endif
Source: "..\..\extension\*"; DestDir: "{app}\extension.next"; Excludes: "tests\*,README.md,package.json"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "Update-GPTWork.ps1"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "Repair-GPTWork.ps1"; DestDir: "{app}\tools"; Flags: ignoreversion

[Dirs]
Name: "{app}\native-messaging"

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.gptlock.core"; ValueType: string; ValueName: ""; ValueData: "{app}\native-messaging\chrome.json"; Flags: uninsdeletekey; Check: ChromeSelected
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.gptlock.core"; ValueType: string; ValueName: ""; ValueData: "{app}\native-messaging\edge.json"; Flags: uninsdeletekey; Check: EdgeSelected

[Icons]
Name: "{group}\GPTWork 扩展目录"; Filename: "{sys}\explorer.exe"; Parameters: """{app}\extension"""
Name: "{group}\检查 GPTWork 更新"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\Update-GPTWork.ps1"""; WorkingDir: "{app}\tools"
Name: "{group}\修复 GPTWork 浏览器连接"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\Repair-GPTWork.ps1"""; WorkingDir: "{app}\tools"
Name: "{group}\卸载 GPTWork"; Filename: "{uninstallexe}"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\Repair-GPTWork.ps1"" -Browser {code:SelectedBrowserArgument} -ChromeStoreExtensionId ""{#ChromeStoreExtensionId}"" -EdgeStoreExtensionId ""{#EdgeStoreExtensionId}"""; Description: "验证所选浏览器连接 / Verify selected browser connection"; Flags: postinstall runhidden waituntilterminated

[Code]
var
  BrowserPage: TInputOptionWizardPage;
  ChromeManifestPaused: Boolean;
  EdgeManifestPaused: Boolean;
  NativeMessagingPaused: Boolean;
  ExtensionSwapped: Boolean;
  InstallCompleted: Boolean;

function JsonEscape(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
end;

function PowerShellSingleQuote(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '''', '''''', True);
end;

procedure InitializeWizard;
var
  RequestedBrowser: String;
begin
  BrowserPage := CreateInputOptionPage(
    wpSelectDir,
    '选择浏览器扩展',
    '请选择要为 GPTWork 配置的浏览器',
    '安装器会部署 GPTWork 扩展文件，并只为你选择的浏览器注册本地连接。普通 Chrome / Edge 仍可能要求在浏览器界面确认启用扩展。',
    True,
    False
  );
  BrowserPage.Add('仅安装到 Chrome / Chrome only');
  BrowserPage.Add('仅安装到 Edge / Edge only');
  BrowserPage.Add('全部安装：Chrome + Edge / Install for both');

  RequestedBrowser := Lowercase(ExpandConstant('{param:Browser|All}'));
  if RequestedBrowser = 'chrome' then
    BrowserPage.SelectedValueIndex := 0
  else if RequestedBrowser = 'edge' then
    BrowserPage.SelectedValueIndex := 1
  else
    BrowserPage.SelectedValueIndex := 2;
end;

function ChromeSelected(): Boolean;
begin
  Result := (BrowserPage = nil) or (BrowserPage.SelectedValueIndex = 0) or (BrowserPage.SelectedValueIndex = 2);
end;

function EdgeSelected(): Boolean;
begin
  Result := (BrowserPage = nil) or (BrowserPage.SelectedValueIndex = 1) or (BrowserPage.SelectedValueIndex = 2);
end;

function SelectedBrowserArgument(Param: String): String;
begin
  if ChromeSelected() and EdgeSelected() then
    Result := 'All'
  else if ChromeSelected() then
    Result := 'Chrome'
  else
    Result := 'Edge';
end;

function PauseNativeManifest(FileName: String; var WasPaused: Boolean): Boolean;
var
  BackupName: String;
begin
  Result := True;
  WasPaused := False;
  BackupName := FileName + '.install-backup';

  if FileExists(BackupName) and not FileExists(FileName) then
  begin
    if not RenameFile(BackupName, FileName) then
    begin
      Result := False;
      exit;
    end;
  end;

  if FileExists(BackupName) and FileExists(FileName) then
  begin
    if not DeleteFile(BackupName) then
    begin
      Result := False;
      exit;
    end;
  end;

  if FileExists(FileName) then
  begin
    if not RenameFile(FileName, BackupName) then
    begin
      Result := False;
      exit;
    end;
    WasPaused := True;
  end;
end;

procedure RestorePausedNativeMessaging;
var
  ChromeManifest: String;
  EdgeManifest: String;
begin
  ChromeManifest := ExpandConstant('{app}\native-messaging\chrome.json');
  EdgeManifest := ExpandConstant('{app}\native-messaging\edge.json');

  if ChromeManifestPaused and FileExists(ChromeManifest + '.install-backup') and
     not FileExists(ChromeManifest) then
    RenameFile(ChromeManifest + '.install-backup', ChromeManifest);
  if EdgeManifestPaused and FileExists(EdgeManifest + '.install-backup') and
     not FileExists(EdgeManifest) then
    RenameFile(EdgeManifest + '.install-backup', EdgeManifest);

  ChromeManifestPaused := False;
  EdgeManifestPaused := False;
  NativeMessagingPaused := False;
end;

function PauseNativeMessaging: Boolean;
var
  ChromeManifest: String;
  EdgeManifest: String;
begin
  if NativeMessagingPaused then
  begin
    Result := True;
    exit;
  end;

  ChromeManifest := ExpandConstant('{app}\native-messaging\chrome.json');
  EdgeManifest := ExpandConstant('{app}\native-messaging\edge.json');

  if not PauseNativeManifest(ChromeManifest, ChromeManifestPaused) then
  begin
    Result := False;
    exit;
  end;

  if not PauseNativeManifest(EdgeManifest, EdgeManifestPaused) then
  begin
    RestorePausedNativeMessaging;
    Result := False;
    exit;
  end;

  NativeMessagingPaused := True;
  Result := True;
end;

procedure FinishNativeMessagingPause;
begin
  DeleteFile(ExpandConstant('{app}\native-messaging\chrome.json.install-backup'));
  DeleteFile(ExpandConstant('{app}\native-messaging\edge.json.install-backup'));
  ChromeManifestPaused := False;
  EdgeManifestPaused := False;
  NativeMessagingPaused := False;
end;

function RecoverInterruptedExtensionSwap(): Boolean;
var
  LiveDir: String;
  NextDir: String;
  PreviousDir: String;
begin
  LiveDir := ExpandConstant('{app}\extension');
  NextDir := ExpandConstant('{app}\extension.next');
  PreviousDir := ExpandConstant('{app}\extension.previous');
  Result := True;

  if (not DirExists(LiveDir)) and DirExists(PreviousDir) then
  begin
    if not RenameFile(PreviousDir, LiveDir) then
    begin
      Result := False;
      exit;
    end;
  end;

  if DirExists(LiveDir) and DirExists(PreviousDir) then
    if not DelTree(PreviousDir, True, True, True) then
    begin
      Result := False;
      exit;
    end;

  if DirExists(NextDir) then
    if not DelTree(NextDir, True, True, True) then
      Result := False;
end;

function SwapExtensionPayload(): Boolean;
var
  LiveDir: String;
  NextDir: String;
  PreviousDir: String;
begin
  LiveDir := ExpandConstant('{app}\extension');
  NextDir := ExpandConstant('{app}\extension.next');
  PreviousDir := ExpandConstant('{app}\extension.previous');
  Result := False;

  if not FileExists(NextDir + '\manifest.json') then
    exit;

  if DirExists(PreviousDir) and not DelTree(PreviousDir, True, True, True) then
    exit;

  if DirExists(LiveDir) then
  begin
    if not RenameFile(LiveDir, PreviousDir) then
      exit;
  end;

  if not RenameFile(NextDir, LiveDir) then
  begin
    if (not DirExists(LiveDir)) and DirExists(PreviousDir) then
      RenameFile(PreviousDir, LiveDir);
    exit;
  end;

  ExtensionSwapped := True;
  Result := True;
end;

procedure RollbackExtensionSwap;
var
  LiveDir: String;
  PreviousDir: String;
begin
  if not ExtensionSwapped then
    exit;
  LiveDir := ExpandConstant('{app}\extension');
  PreviousDir := ExpandConstant('{app}\extension.previous');
  if DirExists(PreviousDir) then
  begin
    if DirExists(LiveDir) then
      DelTree(LiveDir, True, True, True);
    RenameFile(PreviousDir, LiveDir);
  end;
  ExtensionSwapped := False;
end;

procedure FinishExtensionSwap;
begin
  if DirExists(ExpandConstant('{app}\extension.previous')) then
    DelTree(ExpandConstant('{app}\extension.previous'), True, True, True);
  ExtensionSwapped := False;
end;

function StopInstalledCoreProcesses(): Boolean;
var
  CorePath: String;
  EnginePath: String;
  LegacyCorePath: String;
  LegacyEnginePath: String;
  Script: String;
  Params: String;
  ResultCode: Integer;
begin
  CorePath := PowerShellSingleQuote(ExpandConstant('{app}\bin\gptwork-core.exe'));
  EnginePath := PowerShellSingleQuote(ExpandConstant('{app}\bin\gptwork-engine.exe'));
  LegacyCorePath := PowerShellSingleQuote(ExpandConstant('{app}\bin\gptlock-core.exe'));
  LegacyEnginePath := PowerShellSingleQuote(ExpandConstant('{app}\bin\gptlock-engine.exe'));
  Script :=
    '$ErrorActionPreference=''Stop''; ' +
    '$targets=@([IO.Path]::GetFullPath(''' + CorePath + '''),[IO.Path]::GetFullPath(''' + EnginePath + '''),[IO.Path]::GetFullPath(''' + LegacyCorePath + '''),[IO.Path]::GetFullPath(''' + LegacyEnginePath + ''')); ' +
    '$deadline=(Get-Date).AddSeconds(10); $quietSince=$null; ' +
    'do { ' +
    '$matches=@(Get-Process -Name ''gptwork-core'',''gptwork-engine'',''gptlock-core'',''gptlock-engine'' -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and ($targets -contains [IO.Path]::GetFullPath($_.Path)) } catch { $false } }); ' +
    'if ($matches.Count -gt 0) { ' +
    'foreach ($p in $matches) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }; $quietSince=$null ' +
    '} elseif ($null -eq $quietSince) { $quietSince=Get-Date ' +
    '} elseif (((Get-Date)-$quietSince).TotalMilliseconds -ge 1000) { exit 0 }; ' +
    'Start-Sleep -Milliseconds 150; ' +
    '} while ((Get-Date) -lt $deadline); ' +
    'throw ''GPTWork core processes still running or respawning after retry window''';
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Script + '"';
  Result := Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Params,
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) and (ResultCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';

  if not RecoverInterruptedExtensionSwap then
  begin
    Result := '无法恢复上次 GPTWork 扩展更新事务，请完全退出浏览器后重试 / Could not recover the previous GPTWork extension update transaction.';
    exit;
  end;

  if not PauseNativeMessaging then
  begin
    Result := '无法暂停 GPTWork 浏览器本地连接，请完全退出浏览器后重试 / Could not pause GPTWork Native Messaging; fully exit the browser and retry.';
    exit;
  end;

  if FileExists(ExpandConstant('{app}\bin\gptwork-core.exe')) or
     FileExists(ExpandConstant('{app}\bin\gptwork-engine.exe')) or
     FileExists(ExpandConstant('{app}\bin\gptlock-core.exe')) or
     FileExists(ExpandConstant('{app}\bin\gptlock-engine.exe')) then
  begin
    if not StopInstalledCoreProcesses() then
    begin
      RestorePausedNativeMessaging;
      Result := '无法停止正在运行的 GPTWork 本地核心，请完全退出浏览器后重试 / Could not stop the running GPTWork core; fully exit the browser and retry.';
    end;
  end;
end;

procedure WriteNativeManifest(FileName: String; StoreExtensionId: String);
var
  Json: String;
  BinaryPath: String;
  AllowedOrigins: String;
begin
  BinaryPath := JsonEscape(ExpandConstant('{app}\bin\gptwork-core.exe'));
  AllowedOrigins := '"chrome-extension://{#ExtensionId}/"';
  if (StoreExtensionId <> '') and (StoreExtensionId <> '{#ExtensionId}') then
    AllowedOrigins := AllowedOrigins + ', "chrome-extension://' + StoreExtensionId + '/"';
  Json := '{' + #13#10 +
    '  "name": "com.gptlock.core",' + #13#10 +
    '  "description": "GPTWork Local Verification Core",' + #13#10 +
    '  "path": "' + BinaryPath + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": [' + AllowedOrigins + ']' + #13#10 +
    '}' + #13#10;
  if not SaveStringToFile(FileName, UTF8Encode(Json), False) then
    RaiseException('无法写入 Native Messaging 清单 / Cannot write Native Messaging manifest');
end;

procedure RemoveUnselectedBrowserRegistration;
begin
  if not ChromeSelected() then
  begin
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Google\Chrome\NativeMessagingHosts\com.gptlock.core');
    DeleteFile(ExpandConstant('{app}\native-messaging\chrome.json'));
  end;
  if not EdgeSelected() then
  begin
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Edge\NativeMessagingHosts\com.gptlock.core');
    DeleteFile(ExpandConstant('{app}\native-messaging\edge.json'));
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not SwapExtensionPayload then
      RaiseException('无法原子切换 GPTWork 扩展目录；旧扩展保持不变。请关闭占用扩展目录的程序后重试 / Could not atomically swap the GPTWork extension payload.');

    RemoveUnselectedBrowserRegistration;
    if ChromeSelected() then
      WriteNativeManifest(ExpandConstant('{app}\native-messaging\chrome.json'), '{#ChromeStoreExtensionId}');
    if EdgeSelected() then
      WriteNativeManifest(ExpandConstant('{app}\native-messaging\edge.json'), '{#EdgeStoreExtensionId}');
    FinishNativeMessagingPause;
    FinishExtensionSwap;
    InstallCompleted := True;
  end;
end;

procedure DeinitializeSetup;
begin
  if not InstallCompleted then
    RollbackExtensionSwap;
  if NativeMessagingPaused and not InstallCompleted then
    RestorePausedNativeMessaging;
end;
