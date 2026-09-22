param([int]$DurationSeconds=45,[int]$SampleMs=250)
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
 [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenThread(uint access, bool inheritHandle, uint threadId);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int GetThreadDescription(IntPtr hThread, out IntPtr description);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr handle);
 public struct POINT { public int X; public int Y; }
 [StructLayout(LayoutKind.Sequential)]
 public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
}
'@
$threadNameCache=@{}
function Get-ThreadName([int]$ThreadId){
 $key=[string]$ThreadId
 if($threadNameCache.ContainsKey($key)){return $threadNameCache[$key]}
 $name=''
 $h=[GPTWorkInputProbe]::OpenThread(0x0800,$false,[uint32]$ThreadId)
 if($h -ne [IntPtr]::Zero){
  $ptr=[IntPtr]::Zero
  try{
   $hr=[GPTWorkInputProbe]::GetThreadDescription($h,[ref]$ptr)
   if($hr -eq 0 -and $ptr -ne [IntPtr]::Zero){$name=[Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)}
  }catch{}finally{
   if($ptr -ne [IntPtr]::Zero){[void][GPTWorkInputProbe]::LocalFree($ptr)}
   [void][GPTWorkInputProbe]::CloseHandle($h)
  }
 }
 if($null -eq $name){$name=''}
 $threadNameCache[$key]=[string]$name
 return [string]$name
}
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$root=Join-Path $env:USERPROFILE "Desktop\GPTWork-Jank-$stamp"
New-Item -ItemType Directory -Force -Path $root|Out-Null
$errors=New-Object System.Collections.Generic.List[string]
"GPTWork Jank Diagnostic v3 causal A/B`nStarted=$(Get-Date -Format o)`nDurationSeconds=$DurationSeconds`nSampleMs=$SampleMs`nThreadSampleMs=1000`nGpuSampleMs=2000`nAdmin=True`nPrivacy=No typed text, key values, form values, page text, cookies, passwords, browser history, or window titles are collected.`nInputProbe=GetLastInputInfo + cursor/button state only; key values are never read."|Set-Content -Encoding UTF8 "$root\README.txt"
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
$chromeExe=$null
try {$chromeExe=(Get-Command chrome.exe -ErrorAction Stop).Source}catch{}
if(-not $chromeExe){
 $pf86=[Environment]::GetFolderPath('ProgramFilesX86')
 foreach($candidate in @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe","$pf86\Google\Chrome\Application\chrome.exe","$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")){
  if(Test-Path $candidate){$chromeExe=$candidate;break}
 }
}
function Set-GPTWorkIsolation([string]$label,[string]$mode){
 $requestedAt=Get-Date
 $launched=$false
 if($chromeExe){
  try{
   $url="chrome-extension://$ExtensionId/jank-control.html?mode=$mode&stamp=$([uri]::EscapeDataString($requestedAt.ToString('o')))"
   Start-Process -FilePath $chromeExe -ArgumentList @('--new-tab',$url)|Out-Null
   $launched=$true
  }catch{$errors.Add("Isolation $label/$mode launch: $($_.Exception.Message)")}
 }
 $phaseMarkers.Add([pscustomobject]@{Label=$label;Mode=$mode;RequestedAt=$requestedAt.ToString('o');ControlLaunched=$launched})
}
$kindByPid=@{}
foreach($row in $chrome){$kindByPid[[int]$row.PID]=[string]$row.Kind}
$toolLines=@()
foreach($tool in @('wpr.exe','xperf.exe','wpaexporter.exe','tracerpt.exe')){
 $cmd=Get-Command $tool -ErrorAction SilentlyContinue
 $toolLines+="$tool=$([string]$(if($cmd){$cmd.Source}else{'NOT_FOUND'}))"
}
$toolLines|Set-Content -Encoding UTF8 "$root\tooling.txt"
$wprStarted=$false
try {
 $status=(& wpr.exe -status 2>&1|Out-String)
 if($status -notmatch 'recording is in progress'){
   & wpr.exe -start GeneralProfile -filemode 2>&1|Set-Content -Encoding UTF8 "$root\wpr-start.txt"
   $wprStarted=($LASTEXITCODE -eq 0)
 } else {$errors.Add('Existing WPR recording detected; did not disturb it.')}
} catch {$errors.Add("WPR start: $($_.Exception.Message)")}
Write-Host 'Capture starts in 5 seconds. Repeat the SAME browser actions during all five A/B phases: move/resize, type, click, scroll, switch tabs, open menus, send messages.'
5..1|ForEach-Object{Write-Host "$_...";Start-Sleep 1}
$proc=New-Object System.Collections.Generic.List[object]
$thr=New-Object System.Collections.Generic.List[object]
$gpu=New-Object System.Collections.Generic.List[object]
$ui=New-Object System.Collections.Generic.List[object]
$timing=New-Object System.Collections.Generic.List[object]
$phaseMarkers=New-Object System.Collections.Generic.List[object]
$lastCpu=@{};$lastProcCpu=@{};$lastProcAt=@{};$lastCursor=$null;$lastButtons=''
$lastThreadSampleAt=-100000;$lastGpuSampleAt=-100000;$lastSampleAt=$null
$lii=New-Object GPTWorkInputProbe+LASTINPUTINFO
$lii.cbSize=[Runtime.InteropServices.Marshal]::SizeOf([type][GPTWorkInputProbe+LASTINPUTINFO])
[void][GPTWorkInputProbe]::GetLastInputInfo([ref]$lii)
$lastInputTick=$lii.dwTime
$clock=[Diagnostics.Stopwatch]::StartNew()
$endMs=$DurationSeconds*1000.0
$phaseMs=$endMs/5.0
$phasePlan=@(
 [pscustomobject]@{Label='baseline_normal';Mode='normal'},
 [pscustomobject]@{Label='cdp_off';Mode='cdp_off'},
 [pscustomobject]@{Label='normal_recheck';Mode='normal'},
 [pscustomobject]@{Label='content_off';Mode='content_off'},
 [pscustomobject]@{Label='high_level_off';Mode='high_level_off'}
)
$activePhaseIndex=-1
$activePhase=$phasePlan[0]
$nextDue=0.0
while($clock.Elapsed.TotalMilliseconds-lt$endMs){
 $loopStart=$clock.Elapsed.TotalMilliseconds
 $phaseIndex=[math]::Min(4,[math]::Floor($loopStart/$phaseMs))
 if($phaseIndex-ne$activePhaseIndex){
  $activePhaseIndex=$phaseIndex
  $activePhase=$phasePlan[$phaseIndex]
  Write-Host "=== A/B phase $($activePhase.Label) / $($activePhase.Mode) ==="
  Set-GPTWorkIsolation $activePhase.Label $activePhase.Mode
 }
 $now=Get-Date
 $interval=if($null-eq$lastSampleAt){0}else{$loopStart-$lastSampleAt}
 $lastSampleAt=$loopStart
 $sampleThreads=($loopStart-$lastThreadSampleAt-ge1000)
 $sampleGpu=($loopStart-$lastGpuSampleAt-ge2000)
 if($sampleThreads){$lastThreadSampleAt=$loopStart}
 if($sampleGpu){$lastGpuSampleAt=$loopStart}

 $fg=[GPTWorkInputProbe]::GetForegroundWindow();[uint32]$fgPid=0;[void][GPTWorkInputProbe]::GetWindowThreadProcessId($fg,[ref]$fgPid)
 $pt=New-Object GPTWorkInputProbe+POINT;[void][GPTWorkInputProbe]::GetCursorPos([ref]$pt)
 $buttons=@();if(([GPTWorkInputProbe]::GetAsyncKeyState(1)-band 0x8000)-ne 0){$buttons+='L'};if(([GPTWorkInputProbe]::GetAsyncKeyState(2)-band 0x8000)-ne 0){$buttons+='R'};if(([GPTWorkInputProbe]::GetAsyncKeyState(4)-band 0x8000)-ne 0){$buttons+='M'}
 [void][GPTWorkInputProbe]::GetLastInputInfo([ref]$lii)
 $inputChanged=($lii.dwTime-ne$lastInputTick);$lastInputTick=$lii.dwTime
 $cursor="$($pt.X),$($pt.Y)";$buttonText=$buttons -join ''
 $cursorChanged=($cursor-ne$lastCursor);$buttonChanged=($buttonText-ne$lastButtons)
 if($inputChanged-or$cursorChanged-or$buttonChanged){
   $inputClass=if($buttonText-or$buttonChanged){'mouse-button'}elseif($cursorChanged){'pointer'}else{'keyboard-or-other'}
   $ui.Add([pscustomobject]@{Time=$now.ToString('o');ElapsedMs=[math]::Round($loopStart,1);Phase=$activePhase.Label;Mode=$activePhase.Mode;ForegroundPID=$fgPid;CursorX=$pt.X;CursorY=$pt.Y;MouseButtons=$buttonText;InputClass=$inputClass;LastInputTick=$lii.dwTime})
 }
 $lastCursor=$cursor;$lastButtons=$buttonText

 $processes=@(Get-Process chrome,dwm -ErrorAction SilentlyContinue)
 foreach($p in $processes){
  try{
   $pidValue=[int]$p.Id
   $kind=if($p.ProcessName-eq'dwm'){'dwm'}elseif($kindByPid.ContainsKey($pidValue)){$kindByPid[$pidValue]}else{'chrome-unknown'}
   $cpu=[double]$p.TotalProcessorTime.TotalMilliseconds
   $pkey=[string]$pidValue
   $prevCpu=if($lastProcCpu.ContainsKey($pkey)){[double]$lastProcCpu[$pkey]}else{$cpu}
   $prevAt=if($lastProcAt.ContainsKey($pkey)){[double]$lastProcAt[$pkey]}else{$loopStart}
   $cpuDelta=[math]::Max(0,$cpu-$prevCpu);$cpuWindow=[math]::Max(1,$loopStart-$prevAt)
   $lastProcCpu[$pkey]=$cpu;$lastProcAt[$pkey]=$loopStart
   $proc.Add([pscustomobject]@{Time=$now.ToString('o');ElapsedMs=[math]::Round($loopStart,1);Phase=$activePhase.Label;Mode=$activePhase.Mode;Name=$p.ProcessName;Kind=$kind;PID=$pidValue;CpuDeltaMs=[math]::Round($cpuDelta,1);SampleWindowMs=[math]::Round($cpuWindow,1);CpuOneCorePct=[math]::Round(($cpuDelta/$cpuWindow)*100,1);CPUSeconds=[math]::Round($cpu/1000,3);WorkingSetMB=[math]::Round($p.WorkingSet64/1MB,1);PrivateMB=[math]::Round($p.PrivateMemorySize64/1MB,1);Threads=$p.Threads.Count})
   if($sampleThreads){
    foreach($t in $p.Threads){try{
      $key="$($p.Id):$($t.Id)";$tcpu=$t.TotalProcessorTime.TotalMilliseconds;$prev=if($lastCpu.ContainsKey($key)){$lastCpu[$key]}else{$tcpu};$delta=[math]::Max(0,$tcpu-$prev);$lastCpu[$key]=$tcpu
      if($delta-ge 1){$threadName=Get-ThreadName ([int]$t.Id);$thr.Add([pscustomobject]@{Time=$now.ToString('o');ElapsedMs=[math]::Round($loopStart,1);Name=$p.ProcessName;Kind=$kind;PID=$p.Id;TID=$t.Id;ThreadName=$threadName;CpuDeltaMs=[math]::Round($delta,1);State=$t.ThreadState;WaitReason=$(if($t.ThreadState-eq'Wait'){$t.WaitReason}else{''})})}
    }catch{}}
   }
  }catch{}
 }
 if($sampleGpu){try{(Get-Counter '\GPU Engine(*)\Utilization Percentage').CounterSamples|Where-Object CookedValue -gt .5|Sort-Object CookedValue -Descending|Select-Object -First 30|ForEach-Object{$gpu.Add([pscustomobject]@{Time=$now.ToString('o');ElapsedMs=[math]::Round($loopStart,1);Phase=$activePhase.Label;Mode=$activePhase.Mode;Instance=$_.InstanceName;Utilization=[math]::Round($_.CookedValue,2)})}}catch{}}

 $workMs=$clock.Elapsed.TotalMilliseconds-$loopStart
 $timing.Add([pscustomobject]@{Time=$now.ToString('o');ElapsedMs=[math]::Round($loopStart,1);Phase=$activePhase.Label;Mode=$activePhase.Mode;IntervalMs=[math]::Round($interval,1);WorkMs=[math]::Round($workMs,1);RequestedSampleMs=$SampleMs})
 $nextDue+=$SampleMs
 $sleepMs=$nextDue-$clock.Elapsed.TotalMilliseconds
 if($sleepMs-gt 1){Start-Sleep -Milliseconds ([int][math]::Floor($sleepMs))}
 elseif($sleepMs-lt(-$SampleMs)){$nextDue=$clock.Elapsed.TotalMilliseconds}
}
$clock.Stop()
Set-GPTWorkIsolation 'restore_normal' 'normal'
$phaseMarkers|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\phase-markers.csv"
$proc|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\process-samples.csv"
$thr|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\thread-samples.csv"
$gpu|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\gpu-engine-samples.csv"
$ui|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\ui-activity.csv"
$timing|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\capture-timing.csv"
$proc|Group-Object Phase,Mode,Kind,PID|ForEach-Object{[pscustomobject]@{Key=$_.Name;Samples=$_.Count;CpuDeltaMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Sum).Sum),1);MaxSampleMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Maximum).Maximum),1);MaxOneCorePct=[math]::Round((($_.Group|Measure-Object CpuOneCorePct -Maximum).Maximum),1)}}|Sort-Object CpuDeltaMs -Descending|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\phase-cpu-summary.csv"
$proc|Group-Object Kind,PID|ForEach-Object{[pscustomobject]@{Key=$_.Name;Samples=$_.Count;CpuDeltaMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Sum).Sum),1);MaxSampleMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Maximum).Maximum),1);MaxOneCorePct=[math]::Round((($_.Group|Measure-Object CpuOneCorePct -Maximum).Maximum),1)}}|Sort-Object CpuDeltaMs -Descending|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\top-processes.csv"
$thr|Group-Object Kind,PID,TID,ThreadName|ForEach-Object{[pscustomobject]@{Key=$_.Name;Samples=$_.Count;CpuDeltaMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Sum).Sum),1);MaxSampleMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Maximum).Maximum),1)}}|Sort-Object CpuDeltaMs -Descending|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\top-threads.csv"
$intervals=@($timing|Where-Object IntervalMs -gt 0|Select-Object -ExpandProperty IntervalMs|Sort-Object)
$works=@($timing|Select-Object -ExpandProperty WorkMs|Sort-Object)
$medianInterval=if($intervals.Count){$intervals[[math]::Floor(($intervals.Count-1)*.5)]}else{0}
$p95Interval=if($intervals.Count){$intervals[[math]::Floor(($intervals.Count-1)*.95)]}else{0}
$maxInterval=if($intervals.Count){($intervals|Measure-Object -Maximum).Maximum}else{0}
$medianWork=if($works.Count){$works[[math]::Floor(($works.Count-1)*.5)]}else{0}
$p95Work=if($works.Count){$works[[math]::Floor(($works.Count-1)*.95)]}else{0}
$lateCount=@($intervals|Where-Object{$_-gt($SampleMs*1.5)}).Count
@(
 "RequestedSampleMs=$SampleMs"
 "ActualSamples=$($timing.Count)"
 "MedianIntervalMs=$([math]::Round($medianInterval,1))"
 "P95IntervalMs=$([math]::Round($p95Interval,1))"
 "MaxIntervalMs=$([math]::Round([double]$maxInterval,1))"
 "MedianProbeWorkMs=$([math]::Round($medianWork,1))"
 "P95ProbeWorkMs=$([math]::Round($p95Work,1))"
 "IntervalsOver150Percent=$lateCount"
 "Interpretation=If median/p95 interval is far above RequestedSampleMs, the collector itself is too expensive and that run must not be used for fine-grained causality."
)|Set-Content -Encoding UTF8 "$root\capture-health.txt"
if($wprStarted){try{& wpr.exe -stop "$root\browser-jank.etl" 2>&1|Set-Content -Encoding UTF8 "$root\wpr-stop.txt"}catch{$errors.Add("WPR stop: $($_.Exception.Message)")}}
try{
 Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|ForEach-Object{[pscustomobject]@{PID=$_.ProcessId;PPID=$_.ParentProcessId;Kind=(ChromeKind $_.CommandLine);CommandLine=$_.CommandLine}}|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\chrome-process-map-end.csv"
}catch{}
try{
 $health=Get-Content "$root\capture-health.txt" -ErrorAction SilentlyContinue
 $topP=Import-Csv "$root\top-processes.csv" -ErrorAction SilentlyContinue|Select-Object -First 12
 $topT=Import-Csv "$root\top-threads.csv" -ErrorAction SilentlyContinue|Select-Object -First 20
 $summary=New-Object System.Collections.Generic.List[string]
 $summary.Add('GPTWork Jank Diagnostic v2 summary')
 foreach($line in $health){$summary.Add($line)}
 $summary.Add('Top processes:')
 foreach($row in $topP){$summary.Add("  $($row.Key) cpuMs=$($row.CpuDeltaMs) maxSampleMs=$($row.MaxSampleMs) maxOneCorePct=$($row.MaxOneCorePct)")}
 $summary.Add('Top named threads:')
 foreach($row in $topT){$summary.Add("  $($row.Key) cpuMs=$($row.CpuDeltaMs) maxSampleMs=$($row.MaxSampleMs)")}
 $summary.Add('browser-jank.etl is retained for stack-level ETW proof; tooling.txt records local WPA/xperf availability.')
 $summary|Set-Content -Encoding UTF8 "$root\analysis-summary.txt"
}catch{$errors.Add("summary: $($_.Exception.Message)")}
$errors|Set-Content -Encoding UTF8 "$root\errors.txt"
Compress-Archive -Path "$root\*" -DestinationPath "$root.zip" -Force
Write-Host "Done: $root.zip"
Read-Host 'Press Enter to close'
