#define MyAppName "GPTWork"
#ifndef MyAppVersion
  #define MyAppVersion "0.5.55"
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
; Extension UI files are code, not user data. Remove the old snapshot before copying the
; new release so deleted/renamed legacy files can never survive an in-place update.
Type: filesandordirs; Name: "{app}\extension"
Type: files; Name: "{app}\bin\gptlock-core.exe"
Type: files; Name: "{app}\bin\gptlock-engine.exe"
Type: files; Name: "{app}\tools\Update-GPTLock.ps1"
Type: files; Name: "{app}\tools\Repair-GPTLock.ps1"

[Files]
Source: "..\..\native-core\target\release\gptwork-core.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
#if PrivateEnginePath != ""
Source: "{#PrivateEnginePath}"; DestDir: "{app}\bin"; DestName: "gptwork-engine.exe"; Flags: ignoreversion
#endif
Source: "..\..\extension\*"; DestDir: "{app}\extension"; Excludes: "tests\*,README.md,package.json"; Flags: ignoreversion recursesubdirs createallsubdirs
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
    '$deadline=(Get-Date).AddSeconds(8); ' +
    'do { ' +
    '$matches=@(Get-Process -Name ''gptwork-core'',''gptwork-engine'',''gptlock-core'',''gptlock-engine'' -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and ($targets -contains [IO.Path]::GetFullPath($_.Path)) } catch { $false } }); ' +
    'foreach ($p in $matches) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }; ' +
    'Start-Sleep -Milliseconds 150; ' +
    '$remaining=@(Get-Process -Name ''gptwork-core'',''gptwork-engine'',''gptlock-core'',''gptlock-engine'' -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and ($targets -contains [IO.Path]::GetFullPath($_.Path)) } catch { $false } }); ' +
    'if ($remaining.Count -eq 0) { exit 0 } ' +
    '} while ((Get-Date) -lt $deadline); ' +
    'throw ''GPTWork core processes still running after retry window''';
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
  if FileExists(ExpandConstant('{app}\bin\gptwork-core.exe')) or
     FileExists(ExpandConstant('{app}\bin\gptwork-engine.exe')) or
     FileExists(ExpandConstant('{app}\bin\gptlock-core.exe')) or
     FileExists(ExpandConstant('{app}\bin\gptlock-engine.exe')) then
  begin
    if not StopInstalledCoreProcesses() then
      Result := '无法停止正在运行的 GPTWork 本地核心，请完全退出浏览器后重试 / Could not stop the running GPTWork core; fully exit the browser and retry.';
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
    RemoveUnselectedBrowserRegistration;
    if ChromeSelected() then
      WriteNativeManifest(ExpandConstant('{app}\native-messaging\chrome.json'), '{#ChromeStoreExtensionId}');
    if EdgeSelected() then
      WriteNativeManifest(ExpandConstant('{app}\native-messaging\edge.json'), '{#EdgeStoreExtensionId}');
  end;
end;
