@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo Drag a GPTWork-Jank-*.zip onto this BAT, or enter the full path below.
  set /p INPUT=Path: 
) else (
  set "INPUT=%~1"
)
if not defined INPUT exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Analyze-GPTWork-Jank.ps1" -InputPath "%INPUT%"
echo.
pause
