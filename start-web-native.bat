@echo off
REM Kimi Code Web launcher -- starts the Web UI powered by the native Rust server.
REM Usage: double-click or run from cmd/powershell:
REM   start-web-native.bat               - Start native server and open browser
REM   start-web-native.bat --no-open     - Start native server without browser

setlocal

cd /d "%~dp0"

REM 1. Ensure Rust standalone binary is built
set "CLI_EXE=%~dp0packages\kimi-agent\target\release\kimi-agent-cli.exe"
if not exist "%CLI_EXE%" (
    echo Building native Rust agent server binary...
    cd /d "%~dp0packages\kimi-agent"
    cargo build --release --features cli
    if errorlevel 1 (
        echo [ERROR] cargo build failed. Please ensure Rust toolchain is installed.
        pause
        exit /b 1
    )
    cd /d "%~dp0"
)

REM 2. Ensure native tools addon is built if needed
set "NODE_FILE=%~dp0packages\kimi-native-tools\kimi-native-tools.win32-x64-msvc.node"
if not exist "%NODE_FILE%" (
    echo Building native tools addon...
    cd /d "%~dp0packages\kimi-native-tools"
    bun run build 2>&1
    cd /d "%~dp0"
)

REM 3. Launch the web UI backed by the native Rust server
echo Starting Kimi Web UI with Native Rust Server...
call bun run dev:cli web --rust-server %*

endlocal
