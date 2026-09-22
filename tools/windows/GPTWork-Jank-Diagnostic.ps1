param([int]$DurationSeconds=45,[int]$SampleMs=250)
$ErrorActionPreference='Continue'
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
"GPTWork Jank Diagnostic v2`nStarted=$(Get-Date -Format o)`nDurationSeconds=$DurationSeconds`nSampleMs=$SampleMs`nThreadSampleMs=1000`nGpuSampleMs=2000`nAdmin=True`nPrivacy=No typed text, key values, form values, page text, cookies, passwords, browser history, or window titles are collected.`nInputProbe=GetLastInputInfo + cursor/button state only; key values are never read."|Set-Content -Encoding UTF8 "$root\README.txt"
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
$kindByPid=@{}
foreach($row in $chrome){$kindByPid[[int]$row.PID]=[string]$row.Kind}
$wprStarted=$false
try {
 $status=(& wpr.exe -status 2>&1|Out-String)
 if($status -notmatch 'recording is in progress'){
   & wpr.exe -start GeneralProfile -filemode 2>&1|Set-Content -Encoding UTF8 "$root\wpr-start.txt"
   $wprStarted=($LASTEXITCODE -eq 0)
 } else {$errors.Add('Existing WPR recording detected; did not disturb it.')}
} catch {$errors.Add("WPR start: $($_.Exception.Message)")}
Write-Host 'Capture starts in 5 seconds. Reproduce ANY browser stutter: move/resize window, type, click buttons, scroll, switch tabs, open menus, send messages.'
5..1|ForEach-Object{Write-Host "$_...";Start-Sleep 1}
$proc=New-Object System.Collections.Generic.List[object]
$thr=New-Object System.Collections.Generic.List[object]
$gpu=New-Object System.Collections.Generic.List[object]
$ui=New-Object System.Collections.Generic.List[object]
$lastCpu=@{};$lastCursor=$null;$lastButtons=''
$end=(Get-Date).AddSeconds($DurationSeconds)
while((Get-Date)-lt $end){
 $now=Get-Date
 $fg=[GPTWorkInputProbe]::GetForegroundWindow();[uint32]$fgPid=0;[void][GPTWorkInputProbe]::GetWindowThreadProcessId($fg,[ref]$fgPid)
 $pt=New-Object GPTWorkInputProbe+POINT;[void][GPTWorkInputProbe]::GetCursorPos([ref]$pt)
 $buttons=@();if(([GPTWorkInputProbe]::GetAsyncKeyState(1)-band 0x8000)-ne 0){$buttons+='L'};if(([GPTWorkInputProbe]::GetAsyncKeyState(2)-band 0x8000)-ne 0){$buttons+='R'};if(([GPTWorkInputProbe]::GetAsyncKeyState(4)-band 0x8000)-ne 0){$buttons+='M'}
 $keyboard=$false
 foreach($vk in 8..254){if($vk -in 16,17,18,91,92){continue};if(([GPTWorkInputProbe]::GetAsyncKeyState($vk)-band 0x8000)-ne 0){$keyboard=$true;break}}
 $cursor="$($pt.X),$($pt.Y)";$buttonText=$buttons -join ''
 if($cursor-ne $lastCursor -or $buttonText-ne $lastButtons -or $keyboard){
   $ui.Add([pscustomobject]@{Time=$now.ToString('o');ForegroundPID=$fgPid;CursorX=$pt.X;CursorY=$pt.Y;MouseButtons=$buttonText;KeyboardActive=$keyboard})
   $lastCursor=$cursor;$lastButtons=$buttonText
 }
 foreach($p in Get-Process chrome,dwm -ErrorAction SilentlyContinue){
  try{
   $kind=if($p.ProcessName -eq 'dwm'){'dwm'}else{($chrome|Where-Object PID -eq $p.Id|Select-Object -First 1).Kind}
   $proc.Add([pscustomobject]@{Time=$now.ToString('o');Name=$p.ProcessName;Kind=$kind;PID=$p.Id;CPUSeconds=$p.CPU;WorkingSetMB=[math]::Round($p.WorkingSet64/1MB,1);PrivateMB=[math]::Round($p.PrivateMemorySize64/1MB,1);Threads=$p.Threads.Count})
   foreach($t in $p.Threads){try{$key="$($p.Id):$($t.Id)";$cpu=$t.TotalProcessorTime.TotalMilliseconds;$prev=if($lastCpu.ContainsKey($key)){$lastCpu[$key]}else{$cpu};$delta=[math]::Max(0,$cpu-$prev);$lastCpu[$key]=$cpu;if($delta-ge 1){$thr.Add([pscustomobject]@{Time=$now.ToString('o');Name=$p.ProcessName;Kind=$kind;PID=$p.Id;TID=$t.Id;CpuDeltaMs=[math]::Round($delta,1);State=$t.ThreadState;WaitReason=$(if($t.ThreadState -eq 'Wait'){$t.WaitReason}else{''})})}}catch{}}
  }catch{}
 }
 try{(Get-Counter '\GPU Engine(*)\Utilization Percentage').CounterSamples|Where-Object CookedValue -gt .5|Sort-Object CookedValue -Descending|Select-Object -First 30|ForEach-Object{$gpu.Add([pscustomobject]@{Time=$now.ToString('o');Instance=$_.InstanceName;Utilization=[math]::Round($_.CookedValue,2)})}}catch{}
 Start-Sleep -Milliseconds $SampleMs
}
$proc|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\process-samples.csv"
$thr|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\thread-samples.csv"
$gpu|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\gpu-engine-samples.csv"
$ui|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\ui-activity.csv"
$thr|Group-Object Kind,PID,TID|ForEach-Object{[pscustomobject]@{Key=$_.Name;Samples=$_.Count;CpuDeltaMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Sum).Sum),1);MaxSampleMs=[math]::Round((($_.Group|Measure-Object CpuDeltaMs -Maximum).Maximum),1)}}|Sort-Object CpuDeltaMs -Descending|Export-Csv -NoTypeInformation -Encoding UTF8 "$root\top-threads.csv"
if($wprStarted){try{& wpr.exe -stop "$root\browser-jank.etl" 2>&1|Set-Content -Encoding UTF8 "$root\wpr-stop.txt"}catch{$errors.Add("WPR stop: $($_.Exception.Message)")}}
$errors|Set-Content -Encoding UTF8 "$root\errors.txt"
Compress-Archive -Path "$root\*" -DestinationPath "$root.zip" -Force
Write-Host "Done: $root.zip"
Read-Host 'Press Enter to close'
