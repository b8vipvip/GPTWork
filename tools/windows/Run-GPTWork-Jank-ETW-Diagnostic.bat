@echo off
cd /d "%~dp0"
echo GPTWork second-stage ETW jank capture
echo This run records Windows ETW/WPR stacks locally for causal attribution.
echo The ETL can be large and is NOT included in the normal UPLOAD.zip.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0GPTWork-Jank-Diagnostic.ps1" -DurationSeconds 45 -SampleMs 250 -IncludeEtw
