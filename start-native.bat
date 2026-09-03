@echo off
REM Kimi Code launcher with native Rust tools built.
REM Usage:
REM   start-native.bat               - Run Bun CLI with native Rust tools
REM   start-native.bat --pure-rust   - Run pure Rust standalone REPL binary (kimi-agent-cli)

setlocal

set "PURE_RUST=0"
if "%~1"=="--pure-rust" (
    set "PURE_RUST=1"
    shift
)
if "%KIMI_PURE_RUST%"=="1" (
    set "PURE_RUST=1"
)

if "%PURE_RUST%"=="1" (
    set "CLI_EXE=%~dp0packages\kimi-agent\target\release\kimi-agent-cli.exe"
    if not exist "%CLI_EXE%" (
        echo Building pure Rust standalone CLI...
        cd /d "%~dp0\packages\kimi-agent"
        cargo build --release --features cli
        if errorlevel 1 (
            echo [ERROR] cargo build failed.
            pause
            exit /b 1
        )
        cd /d "%~dp0"
    )
    echo Launching pure Rust standalone REPL...
    "%CLI_EXE%" --repl %*
    endlocal
    exit /b %errorlevel%
)

REM Ensure native module is built.
REM napi-rs on Windows produces files named with -msvc suffix.
set "NODE_FILE=%~dp0packages\kimi-native-tools\kimi-native-tools.win32-x64-msvc.node"
if not exist "%NODE_FILE%" (
    if not exist "%~dp0node_modules\@napi-rs\cli" (
        echo [ERROR] napi CLI not installed. Run `bun install` at the repo root first.
        pause
        exit /b 1
    )
    echo Building native tools...
    cd /d "%~dp0\packages\kimi-native-tools"
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

REM Launch kimi-code CLI via Bun.
cd /d "%~dp0"
call bun run dev:cli %*

endlocal
