@echo off
setlocal
cd /d "%~dp0"
if not exist "apps\desktop\package.json" (
    echo [ERROR] apps\desktop is not present in this checkout.
    pause
    exit /b 1
)
echo Starting Kimi Code Desktop with the Bun backend...
call bun run dev:desktop
set EXIT_CODE=%ERRORLEVEL%
endlocal & exit /b %EXIT_CODE%
