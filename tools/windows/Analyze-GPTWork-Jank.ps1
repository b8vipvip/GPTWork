param(
  [Parameter(Mandatory=$true,Position=0)][string]$InputPath,
  [int]$TopProcesses=20,
  [int]$TopThreads=30,
  [int]$TopSpikes=80,
  [switch]$KeepExtracted
)
$ErrorActionPreference='Continue'

function Safe-Double($v,[double]$fallback=0){
  $n=0.0
  if([double]::TryParse([string]$v,[Globalization.NumberStyles]::Any,[Globalization.CultureInfo]::InvariantCulture,[ref]$n)){return $n}
  if([double]::TryParse([string]$v,[ref]$n)){return $n}
  return $fallback
}
function Safe-Date($v){
  $d=[datetime]::MinValue
  if([datetime]::TryParse([string]$v,[ref]$d)){return $d}
  return [datetime]::MinValue
}
function Percentile([object[]]$values,[double]$p){
  $a=@($values | ForEach-Object { Safe-Double $_ } | Sort-Object)
  if($a.Count -eq 0){return 0}
  $i=[math]::Floor(($a.Count-1)*$p)
  return [double]$a[$i]
}
function Read-CsvSafe([string]$path){
  if(!(Test-Path $path)){return @()}
  try { return @(Import-Csv $path -ErrorAction Stop) } catch { return @() }
}
function Copy-IfExists([string]$src,[string]$dstDir){
  if(Test-Path $src){ Copy-Item $src -Destination $dstDir -Force -ErrorAction SilentlyContinue }
}

$resolved=(Resolve-Path $InputPath -ErrorAction Stop).Path
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$workRoot=$null
$sourceRoot=$null
$cleanup=$false

if((Get-Item $resolved).PSIsContainer){
  $sourceRoot=$resolved
}else{
  if([IO.Path]::GetExtension($resolved) -ne '.zip'){throw "Input must be a GPTWork jank folder or .zip: $resolved"}
  $workRoot=Join-Path $env:TEMP "GPTWork-Jank-Analyze-$stamp-$PID"
  New-Item -ItemType Directory -Force -Path $workRoot|Out-Null
  Expand-Archive -LiteralPath $resolved -DestinationPath $workRoot -Force
  $cleanup=$true
  $dirs=@(Get-ChildItem $workRoot -Directory)
  $files=@(Get-ChildItem $workRoot -File)
  if($dirs.Count -eq 1 -and $files.Count -eq 0){$sourceRoot=$dirs[0].FullName}else{$sourceRoot=$workRoot}
}

$outBase=Join-Path ([Environment]::GetFolderPath('Desktop')) "GPTWork-Jank-Analysis-$stamp"
New-Item -ItemType Directory -Force -Path $outBase|Out-Null
$uploadDir=Join-Path $outBase 'UPLOAD'
New-Item -ItemType Directory -Force -Path $uploadDir|Out-Null
$errors=New-Object System.Collections.Generic.List[string]

# 1) Size inventory: first prove why an archive became large.
$inventory=@()
try{
  $inventory=Get-ChildItem $sourceRoot -File -Recurse | ForEach-Object {
    $rel=$_.FullName.Substring($sourceRoot.Length).TrimStart('\','/')
    [pscustomobject]@{File=$rel;Bytes=$_.Length;MB=[math]::Round($_.Length/1MB,3);Extension=$_.Extension}
  } | Sort-Object Bytes -Descending
  $inventory | Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $uploadDir 'source-size-report.csv')
}catch{$errors.Add("size inventory: $($_.Exception.Message)")}

$etlBytes=($inventory|Where-Object Extension -eq '.etl'|Measure-Object Bytes -Sum).Sum
$csvBytes=($inventory|Where-Object Extension -eq '.csv'|Measure-Object Bytes -Sum).Sum
$totalBytes=($inventory|Measure-Object Bytes -Sum).Sum
if($null-eq$etlBytes){$etlBytes=0};if($null-eq$csvBytes){$csvBytes=0};if($null-eq$totalBytes){$totalBytes=0}

# 2) Load known diagnostic tables. Old v0.5.119 and newer formats are supported.
$proc=Read-CsvSafe (Join-Path $sourceRoot 'process-samples.csv')
$thr=Read-CsvSafe (Join-Path $sourceRoot 'thread-samples.csv')
$gpu=Read-CsvSafe (Join-Path $sourceRoot 'gpu-engine-samples.csv')
$ui=Read-CsvSafe (Join-Path $sourceRoot 'ui-activity.csv')
$timing=Read-CsvSafe (Join-Path $sourceRoot 'capture-timing.csv')
$phaseCpu=Read-CsvSafe (Join-Path $sourceRoot 'phase-cpu-summary.csv')
$phaseThr=Read-CsvSafe (Join-Path $sourceRoot 'phase-thread-summary.csv')

# 3) Normalize process CPU. v0.5.119 only has cumulative CPUSeconds.
$procNorm=New-Object System.Collections.Generic.List[object]
if($proc.Count){
  $hasDelta=($proc[0].PSObject.Properties.Name -contains 'CpuDeltaMs')
  if($hasDelta){
    foreach($r in $proc){
      $procNorm.Add([pscustomobject]@{
        Time=[string]$r.Time;ElapsedMs=(Safe-Double $r.ElapsedMs);Phase=[string]$r.Phase;Mode=[string]$r.Mode;
        Name=[string]$r.Name;Kind=[string]$r.Kind;PID=[string]$r.PID;CpuDeltaMs=(Safe-Double $r.CpuDeltaMs);
        CpuOneCorePct=(Safe-Double $r.CpuOneCorePct);WorkingSetMB=(Safe-Double $r.WorkingSetMB);PrivateMB=(Safe-Double $r.PrivateMB);Threads=(Safe-Double $r.Threads)
      })
    }
  }else{
    foreach($g in ($proc|Group-Object PID)){
      $rows=@($g.Group|Sort-Object @{Expression={Safe-Date $_.Time}})
      $prev=$null
      foreach($r in $rows){
        $dt=Safe-Date $r.Time;$cpu=Safe-Double $r.CPUSeconds
        $delta=0.0;$pct=0.0
        if($null-ne$prev){
          $cpuDelta=[math]::Max(0,($cpu-$prev.Cpu)*1000)
          $wall=[math]::Max(1,($dt-$prev.Time).TotalMilliseconds)
          $delta=$cpuDelta;$pct=($cpuDelta/$wall)*100
        }
        $procNorm.Add([pscustomobject]@{Time=[string]$r.Time;ElapsedMs=0;Phase='legacy';Mode='legacy';Name=[string]$r.Name;Kind=[string]$r.Kind;PID=[string]$r.PID;CpuDeltaMs=[math]::Round($delta,2);CpuOneCorePct=[math]::Round($pct,2);WorkingSetMB=(Safe-Double $r.WorkingSetMB);PrivateMB=(Safe-Double $r.PrivateMB);Threads=(Safe-Double $r.Threads)})
        $prev=[pscustomobject]@{Time=$dt;Cpu=$cpu}
      }
    }
  }
}

# 4) Compact process/thread summaries.
$topP=@()
if($procNorm.Count){
  $topP=@($procNorm | Group-Object Kind,PID | ForEach-Object {
    $sum=($_.Group|Measure-Object CpuDeltaMs -Sum).Sum
    $mx=($_.Group|Measure-Object CpuDeltaMs -Maximum).Maximum
    $pct=($_.Group|Measure-Object CpuOneCorePct -Maximum).Maximum
    $ws=($_.Group|Measure-Object WorkingSetMB -Maximum).Maximum
    [pscustomobject]@{Key=$_.Name;Samples=$_.Count;CpuDeltaMs=[math]::Round((Safe-Double $sum),1);MaxSampleMs=[math]::Round((Safe-Double $mx),1);MaxOneCorePct=[math]::Round((Safe-Double $pct),1);MaxWorkingSetMB=[math]::Round((Safe-Double $ws),1)}
  } | Sort-Object CpuDeltaMs -Descending | Select-Object -First $TopProcesses)
  $topP|Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $uploadDir 'top-processes-compact.csv')
}

$topT=@()
if($thr.Count){
  $groupProps=if($thr[0].PSObject.Properties.Name -contains 'ThreadName'){'Kind,PID,TID,ThreadName'}else{'Kind,PID,TID'}
  $topT=@($thr | Group-Object $groupProps | ForEach-Object {
    $sum=($_.Group|Measure-Object CpuDeltaMs -Sum).Sum;$mx=($_.Group|Measure-Object CpuDeltaMs -Maximum).Maximum
    [pscustomobject]@{Key=$_.Name;Samples=$_.Count;CpuDeltaMs=[math]::Round((Safe-Double $sum),1);MaxSampleMs=[math]::Round((Safe-Double $mx),1)}
  } | Sort-Object CpuDeltaMs -Descending | Select-Object -First $TopThreads)
  $topT|Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $uploadDir 'top-threads-compact.csv')
}

# 5) Bounded instantaneous spikes.
$spikes=New-Object System.Collections.Generic.List[object]
if($procNorm.Count){
  foreach($r in ($procNorm|Sort-Object CpuDeltaMs -Descending|Select-Object -First ([math]::Ceiling($TopSpikes/2)))){
    $spikes.Add([pscustomobject]@{Source='process';Time=$r.Time;Phase=$r.Phase;Mode=$r.Mode;Kind=$r.Kind;PID=$r.PID;TID='';ThreadName='';CpuDeltaMs=$r.CpuDeltaMs;CpuOneCorePct=$r.CpuOneCorePct;Detail="WS_MB=$($r.WorkingSetMB)"})
  }
}
if($thr.Count){
  foreach($r in ($thr|Sort-Object @{Expression={Safe-Double $_.CpuDeltaMs};Descending=$true}|Select-Object -First ([math]::Ceiling($TopSpikes/2)))){
    $spikes.Add([pscustomobject]@{Source='thread';Time=[string]$r.Time;Phase=[string]$r.Phase;Mode=[string]$r.Mode;Kind=[string]$r.Kind;PID=[string]$r.PID;TID=[string]$r.TID;ThreadName=[string]$r.ThreadName;CpuDeltaMs=[math]::Round((Safe-Double $r.CpuDeltaMs),1);CpuOneCorePct='';Detail="State=$($r.State);Wait=$($r.WaitReason)"})
  }
}
$spikes|Sort-Object @{Expression={Safe-Double $_.CpuDeltaMs};Descending=$true}|Select-Object -First $TopSpikes|Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $uploadDir 'evidence-top-spikes.csv')

# 6) Capture health and timing outliers.
$healthLines=New-Object System.Collections.Generic.List[string]
if($timing.Count){
  $intervals=@($timing|Where-Object {[double](Safe-Double $_.IntervalMs) -gt 0}|ForEach-Object {Safe-Double $_.IntervalMs})
  $works=@($timing|ForEach-Object {Safe-Double $_.WorkMs})
  $requested=if($timing[0].PSObject.Properties.Name -contains 'RequestedSampleMs'){Safe-Double $timing[0].RequestedSampleMs}else{250}
  $med=Percentile $intervals .5;$p95=Percentile $intervals .95;$max=if($intervals.Count){($intervals|Measure-Object -Maximum).Maximum}else{0}
  $w95=Percentile $works .95
  $late=@($intervals|Where-Object {$_ -gt ($requested*1.5)}).Count
  $healthLines.Add("RequestedSampleMs=$([math]::Round($requested,1))")
  $healthLines.Add("ActualSamples=$($timing.Count)")
  $healthLines.Add("MedianIntervalMs=$([math]::Round($med,1))")
  $healthLines.Add("P95IntervalMs=$([math]::Round($p95,1))")
  $healthLines.Add("MaxIntervalMs=$([math]::Round((Safe-Double $max),1))")
  $healthLines.Add("P95ProbeWorkMs=$([math]::Round($w95,1))")
  $healthLines.Add("IntervalsOver150Percent=$late")
  $threshold=[math]::Max($requested*1.5,$p95)
  $timing|Where-Object {(Safe-Double $_.IntervalMs) -ge $threshold}|Sort-Object @{Expression={Safe-Double $_.IntervalMs};Descending=$true}|Select-Object -First 50|Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $uploadDir 'timing-outliers.csv')
}else{
  $healthLines.Add('CaptureTiming=Unavailable (legacy collector)')
}
$healthLines|Set-Content -Encoding UTF8 (Join-Path $uploadDir 'capture-health-compact.txt')

# 7) A/B phase summaries.
if($phaseCpu.Count){
  $phaseCpu|Select-Object -First 120|Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $uploadDir 'phase-cpu-summary-compact.csv')
}elseif($procNorm.Count -and @($procNorm|Where-Object {$_.Phase -and $_.Phase -ne 'legacy'}).Count){
  $procNorm|Group-Object Phase,Mode,Kind|ForEach-Object{
    [pscustomobject]@{Key=$_.Name;Samples=$_.Count;CpuDeltaMs=[math]::Round((Safe-Double (($_.Group|Measure-Object CpuDeltaMs -Sum).Sum)),1);MaxOneCorePct=[math]::Round((Safe-Double (($_.Group|Measure-Object CpuOneCorePct -Maximum).Maximum)),1)}
  }|Sort-Object CpuDeltaMs -Descending|Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $uploadDir 'phase-cpu-summary-compact.csv')
}
if($phaseThr.Count){$phaseThr|Select-Object -First 160|Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $uploadDir 'phase-thread-summary-compact.csv')}

# 8) GPU compact summary.
if($gpu.Count){
  $gpu|Group-Object Instance|ForEach-Object{
    [pscustomobject]@{Instance=$_.Name;Samples=$_.Count;MaxUtilization=[math]::Round((Safe-Double (($_.Group|Measure-Object Utilization -Maximum).Maximum)),2);AvgUtilization=[math]::Round((Safe-Double (($_.Group|Measure-Object Utilization -Average).Average)),2)}
  }|Sort-Object MaxUtilization -Descending|Select-Object -First 30|Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $uploadDir 'gpu-summary-compact.csv')
}

# 9) Copy small context files only. ETL and raw sample CSVs stay local.
foreach($name in @('README.txt','system.txt','gpu.txt','tooling.txt','errors.txt','wpr-start.txt','wpr-stop.txt','capture-health.txt','analysis-summary.txt','phase-markers.csv','top-processes.csv','top-threads.csv','chrome-process-map.csv','chrome-process-map-end.csv')){
  Copy-IfExists (Join-Path $sourceRoot $name) $uploadDir
}

# 10) Human-readable report.
$summary=New-Object System.Collections.Generic.List[string]
$summary.Add('GPTWork Jank Local Analysis - compact upload report')
$summary.Add("AnalyzedAt=$(Get-Date -Format o)")
$summary.Add("Source=$resolved")
$summary.Add("SourceRoot=$sourceRoot")
$summary.Add("TotalSourceMB=$([math]::Round($totalBytes/1MB,2))")
$summary.Add("ETL_MB=$([math]::Round($etlBytes/1MB,2))")
$summary.Add("CSV_MB=$([math]::Round($csvBytes/1MB,2))")
if($totalBytes -gt 0){
  $summary.Add("ETL_Percent=$([math]::Round(($etlBytes/$totalBytes)*100,1))")
  $summary.Add("CSV_Percent=$([math]::Round(($csvBytes/$totalBytes)*100,1))")
}
$largest=@($inventory|Select-Object -First 8)
$summary.Add('Largest source files:')
foreach($r in $largest){$summary.Add("  $($r.File) = $($r.MB) MB")}
$summary.Add('Capture health:')
foreach($line in $healthLines){$summary.Add("  $line")}
$summary.Add('Top process CPU:')
foreach($r in ($topP|Select-Object -First 10)){$summary.Add("  $($r.Key) cpuMs=$($r.CpuDeltaMs) maxSampleMs=$($r.MaxSampleMs) maxOneCorePct=$($r.MaxOneCorePct)")}
$summary.Add('Top thread CPU:')
foreach($r in ($topT|Select-Object -First 12)){$summary.Add("  $($r.Key) cpuMs=$($r.CpuDeltaMs) maxSampleMs=$($r.MaxSampleMs)")}
$summary.Add("UIActivityRows=$($ui.Count)")
$summary.Add('Important: browser-jank.etl is intentionally NOT copied into the upload bundle. Keep it locally as second-stage evidence.')
$summary.Add('Upload the generated *-UPLOAD.zip to ChatGPT. Only provide the ETL separately if the compact evidence is insufficient.')
$summary|Set-Content -Encoding UTF8 (Join-Path $uploadDir 'ANALYSIS-RESULT.txt')

if($errors.Count){$errors|Set-Content -Encoding UTF8 (Join-Path $uploadDir 'analyzer-errors.txt')}

$zip=Join-Path $outBase "GPTWork-Jank-$stamp-UPLOAD.zip"
Compress-Archive -Path "$uploadDir\*" -DestinationPath $zip -Force
$zipBytes=(Get-Item $zip).Length
"UploadZip=$zip`nUploadZipMB=$([math]::Round($zipBytes/1MB,2))`nOriginalSourceMB=$([math]::Round($totalBytes/1MB,2))`nETLExcludedMB=$([math]::Round($etlBytes/1MB,2))"|Set-Content -Encoding UTF8 (Join-Path $outBase 'RESULT.txt')

Write-Host ''
Write-Host 'Analysis complete.' -ForegroundColor Green
Write-Host "Small upload bundle: $zip" -ForegroundColor Cyan
Write-Host "Upload size: $([math]::Round($zipBytes/1MB,2)) MB"
Write-Host "Original analyzed size: $([math]::Round($totalBytes/1MB,2)) MB"
Write-Host "ETL kept local / excluded from upload: $([math]::Round($etlBytes/1MB,2)) MB"

if($cleanup -and -not $KeepExtracted){Remove-Item $workRoot -Recurse -Force -ErrorAction SilentlyContinue}
