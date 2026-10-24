@echo off
setlocal enabledelayedexpansion

set SRC=%~dp0apps\kimi-code\dist-native\bin\win32-x64\kimi.exe
set DST=%USERPROFILE%\.kimi-code\bin\kimi.exe
set BACKUP=%USERPROFILE%\.kimi-code\bin\kimi.exe.bak

echo === Deploying kimi 2.3.1 ===
echo Source: %SRC%
echo Target: %DST%
echo.

if not exist "%SRC%" (
  echo ERROR: built binary not found at %SRC%
  exit /b 1
)

if not exist "%DST%" (
  echo ERROR: no existing install at %DST%
  exit /b 1
)

echo [1/4] Checking whether the installed binary is in use...
copy /y "%DST%" "%TEMP%\_kimi_lock_probe.exe" >nul 2>&1
if errorlevel 1 (
  echo ERROR: cannot read %DST%
  exit /b 1
)
del /q "%TEMP%\_kimi_lock_probe.exe" >nul 2>&1

ren "%DST%" "kimi.exe.old" >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: %DST% is locked - a kimi process is still running.
  echo Close every kimi window, then run this script again.
  echo.
  echo Running kimi processes:
  tasklist /fi "imagename eq kimi.exe" 2>nul | find /i "kimi.exe"
  exit /b 1
)

echo [2/4] Backing up the previous build...
if exist "%BACKUP%" del /q "%BACKUP%" >nul 2>&1
move /y "%USERPROFILE%\.kimi-code\bin\kimi.exe.old" "%BACKUP%" >nul
if errorlevel 1 (
  echo ERROR: could not move the old binary aside
  exit /b 1
)

echo [3/4] Installing the new build...
copy /y "%SRC%" "%DST%" >nul
if errorlevel 1 (
  echo ERROR: copy failed - restoring the backup
  copy /y "%BACKUP%" "%DST%" >nul
  exit /b 1
)

echo [4/4] Verifying...
for /f "delims=" %%v in ('"%DST%" --version 2^>nul') do set VERSION=%%v
if not "%VERSION%"=="2.3.1" (
  echo ERROR: unexpected version "%VERSION%" - restoring the backup
  copy /y "%BACKUP%" "%DST%" >nul
  exit /b 1
)

echo.
echo OK - kimi %VERSION% deployed to %DST%
echo Backup of the previous build: %BACKUP%
exit /b 0
