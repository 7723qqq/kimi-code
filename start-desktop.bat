@echo off
REM Kimi Code Desktop launcher — builds the native binary (bun) and runs a vendored Electron shell.
REM Usage: double-click or run from cmd/powershell.

setlocal

cd /d "%~dp0"

REM The committed dist-web bundle is authoritative; validate it before building.
node apps\kimi-code\scripts\check-web-assets.mjs
if errorlevel 1 (
    echo [ERROR] Web asset check failed. Sync apps\kimi-code\dist-web from code-app.
    pause
    exit /b 1
)

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

REM Build the native executable (one-time, skip if already built).
if not exist "apps\kimi-code\dist-native\bin\win32-x64\kimi.exe" (
    echo Building native binary (bun)...
    call bun run --cwd apps/kimi-code build:native:bun
    if errorlevel 1 (
        echo [ERROR] Native build failed.
        pause
        exit /b 1
    )
)

REM Launch the Electron shell when it is vendored in this checkout.
REM This fork keeps the desktop shell source outside the repo; the CLI launcher
REM is start-native.bat.
if not exist "apps\kimi-desktop\package.json" (
    echo [ERROR] apps\kimi-desktop is not present in this checkout.
    echo         Use start-native.bat for the native CLI, or vendor the desktop shell first.
    pause
    exit /b 1
)
echo Starting Kimi Code Desktop...
call bun run --cwd apps/kimi-desktop dev

endlocal
