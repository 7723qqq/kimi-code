@echo off
REM Kimi Code launcher (Rust CLI) - builds once, then runs.
REM Uses Windows Terminal when available (full IME/Chinese input support);
REM falls back to the console window otherwise.
REM Usage: double-click, or run from cmd/powershell with optional args,
REM        e.g.  start-native.bat                (enter the TUI)
REM              start-native.bat -p "hello"     (run one prompt)
REM              start-native.bat --version

setlocal
cd /d "%~dp0"

set "KIMI_BIN=%~dp0target\debug\kimi.exe"
if not exist "%KIMI_BIN%" (
    echo Building the Rust CLI - first run only...
    cargo build -p kimi-cli 2>&1
    if errorlevel 1 (
        echo [ERROR] cargo build failed. Make sure Rust is installed: https://rustup.rs
        echo         Windows also needs VS Build Tools: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
        pause
        exit /b 1
    )
)

where wt >nul 2>nul
if %errorlevel%==0 (
    wt.exe -- "%KIMI_BIN%" %*
) else (
    "%KIMI_BIN%" %*
)
endlocal
