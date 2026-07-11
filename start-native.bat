@echo off
REM Kimi Code launcher with native Rust tools built.
REM Usage: double-click or run from cmd/powershell.

setlocal

REM Ensure native module is built.
REM napi-rs on Windows produces files named with -msvc suffix.
set "NODE_FILE=%~dp0packages\kimi-native-tools\kimi-native-tools.win32-x64-msvc.node"
if not exist "%NODE_FILE%" (
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

REM Launch kimi-code CLI via pnpm.
cd /d "%~dp0"
pnpm dev:cli %*

endlocal
