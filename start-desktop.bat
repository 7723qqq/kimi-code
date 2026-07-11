@echo off
REM Kimi Code Desktop launcher — builds the SEA and runs the Electron shell.
REM Usage: double-click or run from cmd/powershell.

setlocal

cd /d "%~dp0"

REM Ensure native module is built.
REM napi-rs on Windows produces files named with -msvc suffix.
if not exist "packages\kimi-native-tools\kimi-native-tools.win32-x64-msvc.node" (
    echo Building native tools...
    cd /d "%~dp0\packages\kimi-native-tools"
    cargo build --release 2>&1
    if errorlevel 1 (
        echo [ERROR] cargo build failed. Make sure Rust and Visual Studio Build Tools are installed.
        echo         https://rustup.rs
        echo         https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
        pause
        exit /b 1
    )
    copy /y "target\release\kimi_native_tools.dll" "kimi-native-tools.win32-x64-msvc.node" >nul
    cd /d "%~dp0"
)

REM Build web UI assets (one-time, skip if already built).
if not exist "apps\kimi-code\dist-web" (
    echo Building web UI...
    call pnpm --filter @moonshot-ai/kimi-web run build
    if errorlevel 1 (
        echo [ERROR] Web UI build failed.
        pause
        exit /b 1
    )
    node apps\kimi-code\scripts\copy-web-assets.mjs
)

REM Build the SEA executable (one-time, skip if already built).
if not exist "apps\kimi-code\dist-native\bin\win32-x64\kimi.exe" (
    echo Building SEA executable...
    call pnpm --filter @moonshot-ai/kimi-code run build:native:sea
    if errorlevel 1 (
        echo [ERROR] SEA build failed.
        pause
        exit /b 1
    )
)

REM Launch Electron desktop.
echo Starting Kimi Code Desktop...
call pnpm -C apps\kimi-desktop run dev

endlocal
