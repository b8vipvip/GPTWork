param([int]$DurationSeconds=60,[int]$SampleMs=250)
$ErrorActionPreference='Continue'
$ExtensionId='bhchcpeodphgjfjoookncemnamdbfcof'
function Is-Admin { $p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
if(-not (Is-Admin)){
  $args="-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -DurationSeconds $DurationSeconds -SampleMs $SampleMs"
  Start-Process powershell.exe -Verb RunAs -ArgumentList $args
  exit
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GPTWorkInputProbe {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
 public struct POINT { public int X; public int Y; }
}
'@
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$root=Join-Path $env:USERPROFILE "Desktop\GPTWork-Jank-$stamp"
New-Item -ItemType Directory -Force -Path $root|Out-Null
$errors=New-Object System.Collections.Generic.List[string]
$phaseMarkers=New-Object System.Collections.Generic.List[object]
$chromeExe=$null
try {$chromeExe=(Get-Command chrome.exe -ErrorAction Stop).Source}catch{}
if(-not $chromeExe){
  $pf86=[Environment]::GetFolderPath('ProgramFilesX86')
  foreach($candidate in @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$pf86\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )){if(Test-Path $candidate){$chromeExe=$candidate;break}}
}
if(-not $chromeExe){$errors.Add('Chrome executable was not found; automatic GPTWork A/B isolation control is unavailable.')}
$phaseSeconds=[math]::Max(8,[math]::Floor($DurationSeconds/5))
$effectiveDuration=$phaseSeconds*5
@"
Started=$(Get-Date -Format o)
RequestedDurationSeconds=$DurationSeconds
EffectiveDurationSeconds=$effectiveDuration
PhaseSeconds=$phaseSeconds
SampleMs=$SampleMs
Admin=True
ABPhases=baseline_normal,cdp_off,normal_recheck,content_off,high_level_off
Privacy=No typed text, key values, form values, page text, cookies, passwords, or browser history are collected.
"@|Set-Content -Encoding UTF8 "$root\README.txt"
Get-CimInstance Win32_OperatingSystem|Format-List Caption,Version,BuildNumber,OSArchitecture,LastBootUpTime|Out-String|Set-Content -Encoding UTF8 "$root\system.txt"
Get-CimInstance Win32_VideoController|Format-List Name,DriverVersion,DriverDate,AdapterRAM,PNPDeviceID|Out-String|Set-Content -Encoding UTF8 "$root\gpu.txt"
try { Start-Process dxdiag.exe -ArgumentList "/dontskip /t `"$root\dxdiag.txt`"" -Wait -WindowStyle Hidden } catch {$errors.Add("dxdiag: $($_.Exception.Message)")}
function ChromeKind($cmd){
 if($cmd -match '--type=gpu-process'){'gpu-process'}
 elseif($cmd -match '--type=renderer' -and $cmd -match '--extension-process'){'extension-renderer'}
 elseif($cmd -match '--type=renderer'){'renderer'}
 elseif($cmd -match '--type=utility'){'utility'}
 elseif($cmd -match '--type='){'other-child'}
 else{'browser'}
}
$chrome=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|ForEach-Object{[pscustomobject]@{PID=$_.ProcessId;PPID=$_.ParentProcessId;Kind=(ChromeKind $_.CommandLine);CommandLine=$_.CommandLine}}
$chrome|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\chrome-process-map.csv"
function Set-GPTWorkIsolation([string]$label,[string]$mode){
  $requestedAt=Get-Date
  $ok=$false
  if($chromeExe){
    try{
      $url="chrome-extension://$ExtensionId/jank-control.html?mode=$mode&stamp=$([uri]::EscapeDataString($requestedAt.ToString('o')))"
      Start-Process -FilePath $chromeExe -ArgumentList @('--new-tab',$url)|Out-Null
      $ok=$true
    }catch{$errors.Add("Isolation $label/$mode launch: $($_.Exception.Message)")}
  }
  Start-Sleep -Milliseconds 1200
  $phaseMarkers.Add([pscustomobject]@{Label=$label;Mode=$mode;RequestedAt=$requestedAt.ToString('o');SamplingStart=(Get-Date).ToString('o');ControlLaunched=$ok})
}
$wprStarted=$false
try {
 $status=(& wpr.exe -status 2>&1|Out-String)
 if($status -notmatch 'recording is in progress'){
   & wpr.exe -start GeneralProfile -filemode 2>&1|Set-Content -Encoding UTF8 "$root\wpr-start.txt"
   $wprStarted=($LASTEXITCODE -eq 0)
 } else {$errors.Add('Existing WPR recording detected; did not disturb it.')}
} catch {$errors.Add("WPR start: $($_.Exception.Message)")}
Write-Host 'GPTWork causal A/B capture starts in 5 seconds.'
Write-Host 'During EACH phase repeat the same actions: move/resize, type, scroll, switch tabs, open menus.'
5..1|ForEach-Object{Write-Host "$_...";Start-Sleep 1}
$proc=New-Object System.Collections.Generic.List[object]
$thr=New-Object System.Collections.Generic.List[object]
$gpu=New-Object System.Collections.Generic.List[object]
$ui=New-Object System.Collections.Generic.List[object]
$lastCpu=@{};$lastCursor=$null;$lastButtons=''
function Sample-Phase([string]$label,[string]$mode,[int]$seconds){
  Write-Host ""
  Write-Host "=== Phase: $label ($mode), $seconds seconds ==="
  Write-Host 'Repeat the SAME browser actions now.'
  Set-GPTWorkIsolation $label $mode
  $end=(Get-Date).AddSeconds($seconds)
  while((Get-Date)-lt $end){
    $now=Get-Date
    $fg=[GPTWorkInputProbe]::GetForegroundWindow();[uint32]$fgPid=0;[void][GPTWorkInputProbe]::GetWindowThreadProcessId($fg,[ref]$fgPid)
    $pt=New-Object GPTWorkInputProbe+POINT;[void][GPTWorkInputProbe]::GetCursorPos([ref]$pt)
    $buttons=@();if(([GPTWorkInputProbe]::GetAsyncKeyState(1)-band 0x8000)-ne 0){$buttons+='L'};if(([GPTWorkInputProbe]::GetAsyncKeyState(2)-band 0x8000)-ne 0){$buttons+='R'};if(([GPTWorkInputProbe]::GetAsyncKeyState(4)-band 0x8000)-ne 0){$buttons+='M'}
    $keyboard=$false
    foreach($vk in 8..254){if($vk -in 16,17,18,91,92){continue};if(([GPTWorkInputProbe]::GetAsyncKeyState($vk)-band 0x8000)-ne 0){$keyboard=$true;break}}
    $cursor="$($pt.X),$($pt.Y)";$buttonText=$buttons -join ''
    if($cursor-ne $script:lastCursor -or $buttonText-ne $script:lastButtons -or $keyboard){
      $ui.Add([pscustomobject]@{Time=$now.ToString('o');Phase=$label;Mode=$mode;ForegroundPID=$fgPid;CursorX=$pt.X;CursorY=$pt.Y;MouseButtons=$buttonText;KeyboardActive=$keyboard})
      $script:lastCursor=$cursor;$script:lastButtons=$buttonText
    }
    foreach($p in Get-Process chrome,dwm -ErrorAction SilentlyContinue){
      try{
        $kind=if($p.ProcessName -eq 'dwm'){'dwm'}else{($chrome|Where-Object PID -eq $p.Id|Select-Object -First 1).Kind}
        if(-not $kind){$kind='chrome-new'}
        $proc.Add([pscustomobject]@{Time=$now.ToString('o');Phase=$label;Mode=$mode;Name=$p.ProcessName;Kind=$kind;PID=$p.Id;CPUSeconds=$p.CPU;WorkingSetMB=[math]::Round($p.WorkingSet64/1MB,1);PrivateMB=[math]::Round($p.PrivateMemorySize64/1MB,1);Threads=$p.Threads.Count})
        foreach($t in $p.Threads){try{$key="$($p.Id):$($t.Id)";$cpu=$t.TotalProcessorTime.TotalMilliseconds;$prev=if($lastCpu.ContainsKey($key)){$lastCpu[$key]}else{$cpu};$delta=[math]::Max(0,$cpu-$prev);$lastCpu[$key]=$cpu;if($delta-ge 1){$thr.Add([pscustomobject]@{Time=$now.ToString('o');Phase=$label;Mode=$mode;Name=$p.ProcessName;Kind=$kind;PID=$p.Id;TID=$t.Id;CpuDeltaMs=[math]::Round($delta,1);State=$t.ThreadState;WaitReason=$(if($t.ThreadState -eq 'Wait'){$t.WaitReason}else{''})})}}catch{}}
      }catch{}
    }
    try{(Get-Counter '\GPU Engine(*)\Utilization Percentage').CounterSamples|Where-Object CookedValue -gt .5|Sort-Object CookedValue -Descending|Select-Object -First 30|ForEach-Object{$gpu.Add([pscustomobject]@{Time=$now.ToString('o');Phase=$label;Mode=$mode;Instance=$_.InstanceName;Utilization=[math]::Round($_.CookedValue,2)})}}catch{}
    Start-Sleep -Milliseconds $SampleMs
  }
}
try{
  Sample-Phase 'baseline_normal' 'normal' $phaseSeconds
  Sample-Phase 'cdp_off' 'cdp_off' $phaseSeconds
  Sample-Phase 'normal_recheck' 'normal' $phaseSeconds
  Sample-Phase 'content_off' 'content_off' $phaseSeconds
  Sample-Phase 'high_level_off' 'high_level_off' $phaseSeconds
} finally {
  Write-Host 'Restoring GPTWork normal mode...'
  Set-GPTWorkIsolation 'restore_normal' 'normal'
}
$phaseMarkers|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\phase-markers.csv"
$proc|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\process-samples.csv"
$thr|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\thread-samples.csv"
$gpu|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\gpu-engine-samples.csv"
$ui|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\ui-activity.csv"
$thr|Group-Object Phase,Mode,Kind,PID|ForEach-Object{[pscustomobject]@{Key=$_.Name;Samples=$_.Count;CpuDeltaMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Sum).Sum),1);MaxSampleMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Maximum).Maximum),1)}}|Sort-Object CpuDeltaMs -Descending|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\phase-cpu-summary.csv"
$thr|Group-Object Phase,Mode,Kind,PID,TID|ForEach-Object{[pscustomobject]@{Key=$_.Name;Samples=$_.Count;CpuDeltaMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Sum).Sum),1);MaxSampleMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Maximum).Maximum),1)}}|Sort-Object CpuDeltaMs -Descending|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\top-threads.csv"
if($wprStarted){try{& wpr.exe -stop "$root\browser-jank.etl" 2>&1|Set-Content -Encoding UTF8 "$root\wpr-stop.txt"}catch{$errors.Add("WPR stop: $($_.Exception.Message)")}}
$errors|Set-Content -Encoding UTF8 "$root\errors.txt"
Compress-Archive -Path "$root\*" -DestinationPath "$root.zip" -Force
Write-Host ""
Write-Host "Done: $root.zip"
Write-Host 'Also export GPTWork runtime JSONL after the test so jank_isolation_changed timestamps can be cross-checked.'
Read-Host 'Press Enter to close'
