@echo off
REM Kimi Code Desktop launcher -- builds the native binary (bun) and runs a vendored Electron shell.
REM Usage: double-click or run from cmd/powershell.

setlocal

cd /d "%~dp0"

REM This fork keeps the desktop shell source outside the repo; fail fast before
REM spending minutes on native builds when it is not vendored in this checkout.
if not exist "apps\kimi-desktop\package.json" (
    echo [ERROR] apps\kimi-desktop is not present in this checkout.
    echo         Use start-native.bat for the native CLI, or vendor the desktop shell first.
    pause
    exit /b 1
)

REM The committed dist-web bundle is authoritative; validate it before building.
bun apps\kimi-code\scripts\check-web-assets.mjs
if errorlevel 1 (
    echo [ERROR] Web asset check failed. Sync apps\kimi-code\dist-web from code-app.
    pause
    exit /b 1
)

REM Ensure the native engine addon is built.
REM napi-rs on Windows produces files named with the -msvc suffix.
if not exist "packages\kimi-agent\kimi_agent.win32-x64-msvc.node" (
    if not exist "%~dp0node_modules\@napi-rs\cli" (
        echo [ERROR] napi CLI not installed. Run `bun install` at the repo root first.
        pause
        exit /b 1
    )
    echo Building the native engine addon...
    cd /d "%~dp0packages\kimi-agent"
    bun run build 2>&1
    if errorlevel 1 (
        echo [ERROR] napi build failed. Make sure Rust and Visual Studio Build Tools are installed.
        echo         https://rustup.rs
        echo         https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
        pause
        exit /b 1
    )
    cd /d "%~dp0"
)

REM Build the native executable (one-time, skip if already built).
if not exist "apps\kimi-code\dist-native\bin\win32-x64\kimi.exe" (
    echo Building native binary (bun)...
    cd /d "%~dp0apps\kimi-code"
    call bun run build:native:bun
    if errorlevel 1 (
        echo [ERROR] Native build failed.
        pause
        exit /b 1
    )
    cd /d "%~dp0"
)

echo Starting Kimi Code Desktop...
cd /d "%~dp0apps\kimi-desktop"
call bun run dev

endlocal & exit /b %errorlevel%
